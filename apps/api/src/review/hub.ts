import { sql } from 'drizzle-orm';
import {
  PLAN_LIMITS, REVIEW_HUB_ACTIVITY_WEEKS, REVIEW_HUB_AHEAD_DAYS, REVIEW_HUB_DEFAULT_SECONDS_PER_CARD, REVIEW_HUB_FORECAST_DAYS, REVIEW_HUB_HARD_CARDS_MAX,
  activityLevel, areas, effectiveNewCardsPerDay, ok, type Area, type GetReviewHub, type MapState, type ReviewHub,
} from '@remoa/contracts';
import { retrievability } from '@remoa/fsrs';
import { run } from '../db';
import { planOf } from '../billing/plan';
import { active, buildQueue, cardState, dayWindow, isDue, itemsOf, loadCards, loadStates, stateKey } from './queue';

const DAY_MS = 86_400_000;
const STREAK_LOOKBACK_DAYS = 400; // ponytail: streaks (and best streak) cap at this
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const ratio = (n: number, hits: number) => (n ? hits / n : null);
const bump = <K>(m: Map<K, { n: number; hits: number }>, key: K, a: { n: number; hits: number }) => {
  const x = m.get(key) ?? m.set(key, { n: 0, hits: 0 }).get(key)!;
  x.n += a.n;
  x.hits += a.hits;
};
const zeroStates = (): Record<MapState, number> => ({ review: 0, watch: 0, steady: 0, unknown: 0 });

/** G15: everything the Revisar page shows, computed on read from `fsrs_state` + `attempts` (no `review_daily`; see D-640). One tx, 5 queries. */
export async function computeReviewHub(userId: string, now: Date): Promise<ReviewHub> {
  const [{ plan }, hub] = await Promise.all([
    planOf(userId, now),
    run(userId, async (tx) => {
      const [cards, states, win, prefRows] = await Promise.all([
        loadCards(tx, userId, null), loadStates(tx, userId, null), dayWindow(tx, userId, now),
        tx.execute<{ n: number | null }>(sql`select new_cards_per_day as n from user_preferences where user_id = ${userId}`),
      ]);
      // one scan of the last STREAK_LOOKBACK_DAYS: per day and board, enough for streaks, the 15-week calendar, retention and areas
      const [attempts, [med]] = await Promise.all([
        tx.execute<{ day: string; board_id: string; area: Area; n: number; hits: number }>(sql`
          select ((a.created_at at time zone ${win.tz}::text) - interval '4 hours')::date::text as day, c.board_id, b.area::text as area,
                 count(*)::int as n, (count(*) filter (where a.grade >= 3))::int as hits
          from attempts a join cards c on c.id = a.card_id join boards b on b.id = c.board_id
          where a.user_id = ${userId} and a.created_at >= (${win.day}::date - ${STREAK_LOOKBACK_DAYS}::int) at time zone ${win.tz}::text + interval '4 hours'
          group by 1, 2, 3`),
        tx.execute<{ m: number | null }>(sql`
          select percentile_cont(0.5) within group (order by duration_ms)::float8 as m
          from (select duration_ms from attempts where user_id = ${userId} and duration_ms > 0 order by created_at desc limit 200) t`),
      ]);
      return { cards, states, win, pref: prefRows[0]?.n ?? null, attempts, studied: new Set(attempts.map((r) => r.day)), medianMs: med?.m ?? null };
    }),
  ]);
  const { cards, states, win, attempts, studied } = hub;
  const today = win.day;

  // --- queue (F03 rule; budget = limit - states introduced today) --------------------------------------------------
  let introduced = 0;
  for (const s of states.values()) if (s.createdMs >= win.startMs) introduced++;
  const newLimit = effectiveNewCardsPerDay(hub.pref, PLAN_LIMITS[plan].newCardsPerDay); // null = unlimited (D-647)
  const newRemaining = newLimit === null ? Infinity : Math.max(0, newLimit - introduced);
  const live = active(cards);
  const items = itemsOf(live, false);
  const secondsPerCard = hub.medianMs ? Math.max(1, Math.round(hub.medianMs / 100) / 10) : REVIEW_HUB_DEFAULT_SECONDS_PER_CARD;
  const kept: ReviewHub['queue']['items'] = [];
  const newPerBoard = new Map<string, number>();
  for (const i of buildQueue(items, states, { now, endMs: win.endMs, newBudget: Infinity })) {
    if (i.reason === 'new') {
      const n = newPerBoard.get(i.boardId) ?? 0;
      if (n >= newRemaining) continue; // any selection takes at most newRemaining new items, so more per board is dead weight
      newPerBoard.set(i.boardId, n + 1);
    }
    kept.push({ ...i, mode: i.mode! });
  }
  const totalNew = kept.filter((i) => i.reason === 'new').length;
  const counts = { due: kept.filter((i) => i.reason === 'due').length, new: Math.min(totalNew, newRemaining), weak: kept.filter((i) => i.reason === 'weak').length };
  const defaultCount = counts.due + counts.new;

  // --- forecast, tomorrow, ahead ------------------------------------------------------------------------------------
  const due = Array<number>(REVIEW_HUB_FORECAST_DAYS).fill(0);
  let dueTomorrow = 0;
  let aheadCount = 0;
  for (const it of items) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (!m) continue;
    const k = isDue(m, win.endMs) ? 0 : Math.floor((m.due.getTime() - win.endMs) / DAY_MS) + 1;
    if (k < REVIEW_HUB_FORECAST_DAYS) due[k]!++;
    if (k === 1) dueTomorrow++;
    if (k >= 1 && k <= REVIEW_HUB_AHEAD_DAYS) aheadCount++;
  }

  // --- states, per board / area ------------------------------------------------------------------------------------
  const boardIds = [...new Set(cards.map((c) => c.boardId))];
  const titles = new Map<string, string>();
  if (boardIds.length) for (const b of await run(userId, (tx) => tx.execute<{ id: string; title: string }>(sql`select id, title from boards where id = any(${`{${boardIds.join(',')}}`}::uuid[])`))) titles.set(b.id, b.title);
  const total = zeroStates();
  const byBoard = new Map<string, { area: Area; cards: number; states: Record<MapState, number> }>();
  for (const c of cards) {
    const st = cardState(c, states, now).state;
    total[st]++;
    const b = byBoard.get(c.boardId) ?? byBoard.set(c.boardId, { area: c.area, cards: 0, states: zeroStates() }).get(c.boardId)!;
    b.cards++;
    b.states[st]++;
  }
  const queueOf = new Map<string, { due: number; new: number; weak: number }>();
  for (const i of kept) {
    const q = queueOf.get(i.boardId) ?? queueOf.set(i.boardId, { due: 0, new: 0, weak: 0 }).get(i.boardId)!;
    q[i.reason]++;
  }

  // --- attempts: per day, per board, per area ----------------------------------------------------------------------
  const perDay = new Map<string, { n: number; hits: number }>();
  const perBoard = new Map<string, { n: number; hits: number }>();
  const perArea = new Map<Area, { n: number; hits: number }>();
  const d30 = addDays(today, -29);
  for (const a of attempts) {
    const d = perDay.get(a.day) ?? perDay.set(a.day, { n: 0, hits: 0 }).get(a.day)!;
    d.n += a.n;
    d.hits += a.hits;
    if (a.day < d30 || a.day > today) continue;
    bump(perBoard, a.board_id, a);
    bump(perArea, a.area, a);
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

  // --- hard cards (concept/case: the card's own state) -------------------------------------------------------------
  const hardRows = live.flatMap((c) => {
    const m = states.get(stateKey(c.id, ''));
    return m && m.reps > 0 && m.lapses > 0 ? [{ c, lapses: m.lapses, r: retrievability(m, now) }] : [];
  }).sort((a, b) => b.lapses - a.lapses || a.r - b.r).slice(0, REVIEW_HUB_HARD_CARDS_MAX);
  const cardTitles = new Map<string, string>();
  if (hardRows.length) for (const r of await run(userId, (tx) => tx.execute<{ id: string; title: string }>(sql`select id, title from cards where id = any(${`{${hardRows.map((h) => h.c.id).join(',')}}`}::uuid[])`))) cardTitles.set(r.id, r.title);

  const reviewed = perDay.get(today)?.n ?? 0;
  const dueByArea = new Map<Area, number>();
  for (const i of kept) if (i.reason === 'due') dueByArea.set(byBoard.get(i.boardId)!.area, (dueByArea.get(byBoard.get(i.boardId)!.area) ?? 0) + 1);
  const cardsByArea = new Map<Area, number>();
  for (const b of byBoard.values()) cardsByArea.set(b.area, (cardsByArea.get(b.area) ?? 0) + b.cards);
  const status: ReviewHub['status'] = cards.length === 0 ? 'empty' : studied.size === 0 ? 'no_history' : defaultCount === 0 ? 'done' : 'active';

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
      firmTotal: cards.length,
      firmPct: cards.length ? Math.round((total.steady / cards.length) * 100) : 0,
    },
    forecast: due.map((count, k) => ({ date: addDays(today, k), count })),
    states: total,
    retention: { d7: retentionPoints(7, 1), d30: retentionPoints(30, 1), d90: retentionPoints(30, 3) },
    activity,
    areas: areas.map((area) => {
      const x = perArea.get(area);
      return { area, cards: cardsByArea.get(area) ?? 0, dueToday: dueByArea.get(area) ?? 0, attempts: x?.n ?? 0, accuracy: x ? ratio(x.n, x.hits) : null };
    }),
    hardCards: hardRows.map((h) => ({ cardId: h.c.id, boardId: h.c.boardId, boardTitle: titles.get(h.c.boardId) ?? '', title: cardTitles.get(h.c.id) ?? '', r: h.r, lapses: h.lapses })),
    maps: [...byBoard].sort(([ia], [ib]) => (titles.get(ia) ?? '').localeCompare(titles.get(ib) ?? '') || (ia < ib ? -1 : 1)).map(([boardId, b]) => { // stable order (title, id): card load order varied between runs
      const q = queueOf.get(boardId) ?? { due: 0, new: 0, weak: 0 };
      const x = perBoard.get(boardId);
      return { boardId, title: titles.get(boardId) ?? '', area: b.area, cards: b.cards, states: b.states, ...q, retention30: x ? ratio(x.n, x.hits) : null };
    }),
  };
}

// ponytail: in-process cache, correct for a single API instance only (same ceiling as the retrievability cache in ./queue). Shared cache (Redis) when the API scales out.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; nowMs: number; hub: ReviewHub }>();
export const invalidateReviewHub = (userId: string) => void cache.delete(userId);

export const getReviewHub: GetReviewHub = async (userId, now) => {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS && Math.abs(now.getTime() - hit.nowMs) < TTL_MS) return ok(hit.hub);
  const hub = await computeReviewHub(userId, now);
  cache.set(userId, { at: Date.now(), nowMs: now.getTime(), hub });
  return ok(hub);
};
