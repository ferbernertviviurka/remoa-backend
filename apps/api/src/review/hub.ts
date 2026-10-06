import { sql, type SQL } from 'drizzle-orm';
import {
  REVIEW_HUB_ACTIVITY_WEEKS, REVIEW_HUB_AHEAD_DAYS, REVIEW_HUB_DEFAULT_SECONDS_PER_CARD, REVIEW_HUB_FORECAST_DAYS, REVIEW_HUB_HARD_CARDS_MAX,
  activityLevel, areas, cacheTags, ok, type Area, type GetReviewHub, type MapState, type ReviewHub,
} from '@remoa/contracts';
import { retrievability } from '@remoa/fsrs';
import { run } from '../db';
import { cached, type UserCacheDef } from '../cache';
import { planOf } from '../billing/plan';
import { budgetOf, budgetSql, newBoundSql, dueByOffsetSql, dueFrom, queueRowsSql, recallSql, sortQueueRows, toWindow, W, windowSql, type QueueSqlRow, type WindowSqlRow } from './queue';
import { mapStatsFrom, mapStatsSql, scopeBoardsSql, type MapStatsData, type ScopeBoard } from './stats';

const DAY_MS = 86_400_000;
const STREAK_LOOKBACK_DAYS = 400; // ponytail: streaks (and best streak) cap at this
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const ratio = (n: number, hits: number) => (n ? hits / n : null);
const zeroStates = (): Record<MapState, number> => ({ review: 0, watch: 0, steady: 0, unknown: 0 });

/**
 * G15: everything the Revisar page shows. G21 FR-22/FR-23 (D-1027..D-1030): one transaction, no read of every card/state/attempt:
 * the queue is the indexed SQL of `queueRows`, per-board totals come from `map_stats`, the 400-day series from `user_daily_stats`,
 * per board/area accuracy from 30 days of `attempts` (range on `attempts_user_created_idx`), hard cards by `order by ... limit`.
 */
export async function computeReviewHub(userId: string, now: Date): Promise<ReviewHub> {
  // G21 D-1094: ONE statement in the transaction (+1 upsert when a map_stats row is stale) and the plan's, in the same flight (was 2
  // sequential): the study day is the CTE `w`, the new-card budget inputs come back in the row, and new items are fetched up to the
  // bound of the budget per board (newBoundSql) and cut to the plan's remaining budget per board here.
  const hub = await run(userId, async (tx) => {
    const plan = planOf(userId, now, tx); // same flight (D-1095)
    plan.catch(() => undefined);
    const json = (q: SQL | null) => (q ? sql`(select coalesce(json_agg(t), '[]') from (${q}) t)` : sql`'[]'::json`);
    const b = budgetSql(userId, W.startMs);
    const perBoard = newBoundSql(userId, b, now);
    const queue = queueRowsSql({ userId, boardId: null }, { now, endMs: W.endMs, due: null, weak: null, fresh: { limit: null, perBoard } });
    const forecastDays = Math.max(REVIEW_HUB_FORECAST_DAYS, REVIEW_HUB_AHEAD_DAYS + 1);
    const [r] = await tx.execute<{
      w: WindowSqlRow; budget: { pref: number | null; introduced: number };
      boards: ScopeBoard[]; due: { k: number; n: number }[]; days: { day: string; n: number; hits: number }[]; recent: { board_id: string; area: Area; n: number; hits: number }[];
      hard: { card_id: string; board_id: string; board_title: string; title: string; lapses: number; stability: number; difficulty: number; due: string; reps: number; last_review: string | null; state: 'new' | 'learning' | 'review' | 'relearning'; learning_steps: number; scheduled_days: number }[];
      med: number | null; items: QueueSqlRow[]; stats: MapStatsData;
    }>(sql`
      with w as (${windowSql(userId, now)}), sb as (${scopeBoardsSql(userId)})
      select (select row_to_json(w) from w) as w, (select row_to_json(b) from (${b}) b) as budget,
        (select coalesce(json_agg(sb), '[]') from sb) as boards,
        ${json(dueByOffsetSql(userId, { endMs: W.endMs }, forecastDays))} as due,
        ${json(sql`select day::text, reviews as n, hits from user_daily_stats where user_id = ${userId} and day >= (select day from w)::date - ${STREAK_LOOKBACK_DAYS}::int`)} as days,
        ${json(sql`
        select c.board_id, b.area::text as area, sum(a.n)::int as n, sum(a.hits)::int as hits
        from (
          select card_id, count(*) as n, count(*) filter (where grade >= 3) as hits from attempts
          where user_id = ${userId} and created_at >= to_timestamp((${W.startMs} - ${29 * DAY_MS}) / 1000) and created_at < to_timestamp(${W.endMs} / 1000) group by 1
        ) a -- grouped per card first (attempts_user_created_idx), then one PK probe per card (see queue.ts stateItemsSql)
        cross join lateral (select c.board_id from cards c where c.id = a.card_id offset 0) c
        cross join lateral (select b.area from boards b where b.id = c.board_id offset 0) b
        group by 1, 2`)} as recent,
        ${json(sql`
        select f.card_id, c.board_id, b.title as board_title, c.title, f.lapses, f.stability, f.difficulty, f.due, f.reps, f.last_review, f.state::text as state, f.learning_steps, f.scheduled_days
        from fsrs_state f
        cross join lateral (select c.board_id, c.title, c.type, c.deleted_at, c.suspended_at from cards c where c.id = f.card_id offset 0) c
        cross join lateral (select b.title, b.archived_at from boards b where b.id = c.board_id offset 0) b
        where f.user_id = ${userId} and f.sub_id = '' and f.reps > 0 and f.lapses > 0 and c.deleted_at is null and c.suspended_at is null and c.type <> 'note' and b.archived_at is null
        order by f.lapses desc, ${recallSql(now.getTime())}, f.card_id limit ${REVIEW_HUB_HARD_CARDS_MAX}`)} as hard,
        (select percentile_cont(0.5) within group (order by duration_ms)::float8
          from (select duration_ms from attempts where user_id = ${userId} and duration_ms > 0 order by created_at desc limit 200) t) as med,
        ${json(queue)} as items,
        ${mapStatsSql(userId, sql`array(select id from sb)`, now.getTime(), W.endMs)} as stats`);
    const win = toWindow(r!.w);
    const budget = budgetOf(r!.budget, (await plan).plan);
    // new items: at most the day's remaining cap per board (any selection takes at most newRemaining, so more per board is dead weight)
    const sorted = sortQueueRows(r!.items);
    const seen = new Map<string, number>();
    sorted.new = sorted.new.filter((i) => {
      const n = (seen.get(i.boardId) ?? 0) + 1;
      seen.set(i.boardId, n);
      return n <= budget.remaining;
    });
    const stats = await mapStatsFrom(tx, userId, [...new Set(r!.boards.map((x) => x.id))], r!.stats, now);
    return { win, budget, boards: r!.boards, items: sorted, stats, due: dueFrom(r!.due, forecastDays), days: r!.days, recent: r!.recent, hard: r!.hard, medianMs: r!.med };
  });
  const { win, budget, boards, items, stats, days, recent } = hub;
  const today = win.day;

  // --- queue (F03 rule; budget = limit - states introduced today) --------------------------------------------------
  const newLimit = budget.limit;
  const newRemaining = budget.remaining;
  const secondsPerCard = hub.medianMs ? Math.max(1, Math.round(hub.medianMs / 100) / 10) : REVIEW_HUB_DEFAULT_SECONDS_PER_CARD;
  const kept: ReviewHub['queue']['items'] = [...items.due, ...items.new, ...items.weak].map((i) => ({ ...i, mode: i.mode! }));
  const totalNew = items.new.length;
  const counts = { due: items.due.length, new: Math.min(totalNew, newRemaining), weak: items.weak.length };
  const defaultCount = counts.due + counts.new;

  // --- forecast, tomorrow, ahead ------------------------------------------------------------------------------------
  const dueTomorrow = hub.due[1] ?? 0;
  let aheadCount = 0;
  for (let k = 1; k <= REVIEW_HUB_AHEAD_DAYS; k++) aheadCount += hub.due[k] ?? 0;

  // --- states, per board / area (map_stats) ------------------------------------------------------------------------
  const titles = new Map(boards.map((b) => [b.id, b.title]));
  const total = zeroStates();
  let cardCount = 0;
  const byBoard = new Map<string, { area: Area; cards: number; states: Record<MapState, number> }>();
  for (const b of boards) {
    const st = stats.get(b.id);
    if (!st || st.cards === 0) continue; // the old hub listed boards with at least one in-scope card
    cardCount += st.cards;
    for (const k of Object.keys(total) as MapState[]) total[k] += st.states[k];
    byBoard.set(b.id, { area: b.area, cards: st.cards, states: st.states });
  }
  const queueOf = new Map<string, { due: number; new: number; weak: number }>();
  for (const i of kept) {
    const q = queueOf.get(i.boardId) ?? queueOf.set(i.boardId, { due: 0, new: 0, weak: 0 }).get(i.boardId)!;
    q[i.reason]++;
  }

  // --- attempts: per day (user_daily_stats), per board / area (last 30 days) ----------------------------------------
  const perDay = new Map(days.map((d) => [d.day, { n: d.n, hits: d.hits }]));
  const studied = new Set(days.filter((d) => d.n > 0).map((d) => d.day));
  const perBoard = new Map<string, { n: number; hits: number }>();
  const perArea = new Map<Area, { n: number; hits: number }>();
  for (const a of recent) {
    const b = perBoard.get(a.board_id) ?? perBoard.set(a.board_id, { n: 0, hits: 0 }).get(a.board_id)!;
    b.n += a.n;
    b.hits += a.hits;
    const x = perArea.get(a.area) ?? perArea.set(a.area, { n: 0, hits: 0 }).get(a.area)!;
    x.n += a.n;
    x.hits += a.hits;
  }
  const sumDays = (from: string, to: string) => {
    let n = 0;
    let hits = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const x = perDay.get(d);
      if (x) { n += x.n; hits += x.hits; }
    }
    return { n, hits };
  };
  const retentionPoints = (count: number, step: number) =>
    Array.from({ length: count }, (_, i) => {
      const end = addDays(today, -(count - 1 - i) * step);
      const x = sumDays(addDays(end, -(step - 1)), end);
      return { date: end, value: ratio(x.n, x.hits) };
    });
  const d30 = addDays(today, -29);
  const r30 = sumDays(d30, today);
  const prev30 = sumDays(addDays(today, -59), addDays(today, -30));
  const retention30 = ratio(r30.n, r30.hits);
  const prevRetention = ratio(prev30.n, prev30.hits);

  // --- activity (Monday-first), streaks ----------------------------------------------------------------------------
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(today, -dow - (REVIEW_HUB_ACTIVITY_WEEKS - 1) * 7);
  const activity = Array.from({ length: REVIEW_HUB_ACTIVITY_WEEKS * 7 }, (_, i) => {
    const date = addDays(start, i);
    const count = date > today ? 0 : (perDay.get(date)?.n ?? 0);
    return { date, count, level: activityLevel(count), future: date > today };
  });
  let streak = 0;
  for (let d = studied.has(today) ? today : addDays(today, -1); studied.has(d); d = addDays(d, -1)) streak++;
  let bestStreak = 0;
  for (const d of studied) {
    if (studied.has(addDays(d, -1))) continue; // only run starts
    let n = 0;
    for (let x = d; studied.has(x); x = addDays(x, 1)) n++;
    bestStreak = Math.max(bestStreak, n);
  }

  // --- hard cards (concept/case: the card's own state), recall of the 10 picked in ts-fsrs ---------------------------
  const hardCards = hub.hard.map((h) => ({
    cardId: h.card_id, boardId: h.board_id, boardTitle: h.board_title, title: h.title, lapses: h.lapses,
    r: retrievability({ stability: h.stability, difficulty: h.difficulty, due: new Date(h.due), reps: h.reps, lapses: h.lapses, lastReview: h.last_review ? new Date(h.last_review) : null, state: h.state, learningSteps: h.learning_steps, scheduledDays: h.scheduled_days }, now),
  }));

  const reviewed = perDay.get(today)?.n ?? 0;
  const dueByArea = new Map<Area, number>();
  for (const i of items.due) {
    const area = byBoard.get(i.boardId)?.area;
    if (area) dueByArea.set(area, (dueByArea.get(area) ?? 0) + 1);
  }
  const cardsByArea = new Map<Area, number>();
  for (const b of byBoard.values()) cardsByArea.set(b.area, (cardsByArea.get(b.area) ?? 0) + b.cards);
  const status: ReviewHub['status'] = cardCount === 0 ? 'empty' : studied.size === 0 ? 'no_history' : defaultCount === 0 ? 'done' : 'active';

  return {
    status,
    generatedAt: now,
    today: { day: today, reviewed },
    queue: { items: kept, counts, defaultCount, newLimit, newRemaining: newLimit === null ? null : newRemaining, secondsPerCard, estimatedSeconds: Math.round(defaultCount * secondsPerCard), dueTomorrow, aheadCount },
    kpis: {
      streak,
      bestStreak,
      weekDots: activity.slice(-7).map((a) => a.count > 0),
      retention30,
      retentionDelta: retention30 === null || prevRetention === null ? null : Math.round((retention30 - prevRetention) * 100),
      reviews7: sumDays(addDays(today, -6), today).n,
      firm: total.steady,
      firmTotal: cardCount,
      firmPct: cardCount ? Math.round((total.steady / cardCount) * 100) : 0,
    },
    forecast: hub.due.slice(0, REVIEW_HUB_FORECAST_DAYS).map((count, k) => ({ date: addDays(today, k), count })),
    states: total,
    retention: { d7: retentionPoints(7, 1), d30: retentionPoints(30, 1), d90: retentionPoints(30, 3) },
    activity,
    areas: areas.map((area) => {
      const x = perArea.get(area);
      return { area, cards: cardsByArea.get(area) ?? 0, dueToday: dueByArea.get(area) ?? 0, attempts: x?.n ?? 0, accuracy: x ? ratio(x.n, x.hits) : null };
    }),
    hardCards,
    maps: [...byBoard].sort(([ia], [ib]) => (titles.get(ia) ?? '').localeCompare(titles.get(ib) ?? '') || (ia < ib ? -1 : 1)).map(([boardId, b]) => { // stable order (title, id)
      const q = queueOf.get(boardId) ?? { due: 0, new: 0, weak: 0 };
      const x = perBoard.get(boardId);
      return { boardId, title: titles.get(boardId) ?? '', area: b.area, cards: b.cards, states: b.states, ...q, retention30: x ? ratio(x.n, x.hits) : null };
    }),
  };
}

// G21 T7: L1 cache of the cache/ module (FR-32/FR-44). Dropped by review.answered, card.changed, map.changed, plan.changed.
// The minute of `now` is in the key, as the old Map compared it (a different clock never reuses a hub).
const hubCache = (now: Date): UserCacheDef<{ userId: string }> => ({
  scope: 'user', name: 'review-hub', ttl: 'live', key: () => [Math.floor(now.getTime() / 60_000)],
  tags: ({ userId }) => [cacheTags.user(userId, 'review'), cacheTags.user(userId, 'stats'), cacheTags.user(userId, 'progress')],
});

export const getReviewHub: GetReviewHub = async (userId, now) => ok(await cached(hubCache(now), { userId }, () => computeReviewHub(userId, now)));
