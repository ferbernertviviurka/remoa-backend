import { sql } from 'drizzle-orm';
import {
  PLAN_LIMITS, PREVIEW_MAX_NODES, effectiveNewCardsPerDay, err, idSchema, ok, type ChallengeMode, type CardType, type FsrsCardState, type FsrsMemory, type GetBoardQueue,
  type BoardSummary, type GetDailyQueue, type GetRetrievability, type MapState, type QueueItem, type RetrievabilityMap,
} from '@remoa/contracts';
import { aggregate, mapState, retrievability, STEADY_FROM } from '@remoa/fsrs';
import type { Tx } from '@remoa/db';
import { run } from '../db';
import { planOf } from '../billing/plan';

const ROLLOVER_HOUR = 4; // FRD: the study day rolls over at 04:00 local
const DEFAULT_TZ = 'America/Sao_Paulo';
const MODE: Record<CardType, ChallengeMode> = { concept: 'hidden_card', case: 'case', flow: 'next_step', image: 'occlusion' };

type CardRow = { id: string; boardId: string; type: CardType; order: number; boardMs: number; own: boolean; subs: string[]; x: number; y: number };
type StateRow = FsrsMemory & { cardId: string; subId: string; createdMs: number };
type Item = { cardId: string; boardId: string; subId: string; mode: ChallengeMode; order: number; boardMs: number; idx: number; newAllowed: boolean };

const stateKey = (cardId: string, subId: string) => `${cardId}\u0000${subId}`;
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const isDue = (m: FsrsMemory, endMs: number) => m.due.getTime() < endMs;

// --- loading (set-based: one query for cards, one for states) ---------------------------------------------------

const subIds = (key: 'steps' | 'masks') => sql`case when jsonb_typeof(c.payload->${key}::text) = 'array' then coalesce((
  select jsonb_agg(x->>'id' order by ord) from jsonb_array_elements(c.payload->${key}::text) with ordinality t(x, ord) where jsonb_typeof(x) = 'object' and x->>'id' is not null
), '[]'::jsonb) else '[]'::jsonb end`;

/** RLS (withUser) decides what is readable. `boardId` null = daily scope: live cards of non-archived boards the user owns or has study state on. */
async function loadCards(tx: Tx, userId: string, boardId: string | null): Promise<CardRow[]> {
  const scope = boardId
    ? sql`c.board_id = ${boardId}`
    : sql`b.archived_at is null and (b.user_id = ${userId} or exists (select 1 from fsrs_state s where s.user_id = ${userId} and s.card_id = c.id))`;
  const rows = await tx.execute<{ id: string; board_id: string; type: CardType; order: number; board_ms: number; own: boolean; subs: string[]; x: number; y: number }>(sql`
    select c.id, c.board_id, c.type, c."order", c.x, c.y, (extract(epoch from b.updated_at) * 1000)::float8 as board_ms, (b.user_id = ${userId}) as own,
      case c.type when 'flow' then ${subIds('steps')} when 'image' then ${subIds('masks')} else '[""]'::jsonb end as subs
    from cards c join boards b on b.id = c.board_id
    where c.deleted_at is null and ${scope}`);
  return rows.map((r) => ({ id: r.id, boardId: r.board_id, type: r.type, order: r.order, boardMs: r.board_ms, own: r.own, subs: r.subs, x: r.x, y: r.y }));
}

/**
 * `cardIds` null = every state of the user. Scoping by ids (PK lookups) instead of a subquery on `cards`: the cards RLS
 * subquery isn't leakproof, so `card_id in (select … from cards)` planned as a nested loop (~200 ms for 500 cards).
 */
async function loadStates(tx: Tx, userId: string, cardIds: string[] | null) {
  const scope = cardIds ? sql`and card_id = any(${`{${cardIds.join(',')}}`}::uuid[])` : sql``;
  const rows = await tx.execute<{
    card_id: string; sub_id: string; stability: number; difficulty: number; due_ms: number; reps: number; lapses: number;
    last_ms: number | null; state: FsrsCardState; learning_steps: number; scheduled_days: number; created_ms: number;
  }>(sql`
    select card_id, sub_id, stability, difficulty, (extract(epoch from due) * 1000)::float8 as due_ms, reps, lapses,
      (extract(epoch from last_review) * 1000)::float8 as last_ms, state, learning_steps, scheduled_days,
      (extract(epoch from created_at) * 1000)::float8 as created_ms
    from fsrs_state where user_id = ${userId} ${scope}`);
  return new Map<string, StateRow>(
    rows.map((r) => [
      stateKey(r.card_id, r.sub_id),
      {
        cardId: r.card_id, subId: r.sub_id, stability: r.stability, difficulty: r.difficulty, due: new Date(Math.round(r.due_ms)), reps: r.reps,
        lapses: r.lapses, lastReview: r.last_ms === null ? null : new Date(Math.round(r.last_ms)), state: r.state, learningSteps: r.learning_steps,
        scheduledDays: r.scheduled_days, createdMs: Math.round(r.created_ms),
      },
    ]),
  );
}

/** "Today" = user's timezone, rolling over at 04:00 local. Returns the next rollover and the start of the current study day (epoch ms). */
export async function dayWindow(tx: Tx, userId: string, now: Date) {
  const [p] = await tx.execute<{ tz: string }>(sql`select timezone as tz from profiles where user_id = ${userId}`);
  let tz = p?.tz ?? DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    tz = DEFAULT_TZ;
  }
  const [w] = await tx.execute<{ start_ms: number; end_ms: number; day: string }>(sql`
    with l as (select ((${now.toISOString()}::timestamptz at time zone ${tz}::text) - make_interval(hours => ${ROLLOVER_HOUR}))::date as d)
    select l.d::text as day, (extract(epoch from ((l.d + time '04:00') at time zone ${tz}::text)) * 1000)::float8 as start_ms,
           (extract(epoch from (((l.d + 1) + time '04:00') at time zone ${tz}::text)) * 1000)::float8 as end_ms from l`);
  return { startMs: Math.round(w!.start_ms), endMs: Math.round(w!.end_ms), day: w!.day, tz };
}

/** D-057: concept/case = the card; flow = one item per step; image = one per mask. */
const itemsOf = (cards: CardRow[], boardScope: boolean): Item[] =>
  cards.flatMap((c) =>
    c.subs.map((subId, idx) => ({
      cardId: c.id, boardId: c.boardId, subId, mode: MODE[c.type], order: c.order, boardMs: c.boardMs, idx, newAllowed: boardScope || c.own,
    })),
  );

// --- pure queue rule (FR-6) -------------------------------------------------------------------------------------

export function buildQueue(
  items: Item[], states: Map<string, StateRow>, o: { now: Date; endMs: number; newBudget: number; limit?: number },
): QueueItem[] {
  const due: { it: Item; r: number }[] = [];
  const weak: { it: Item; r: number }[] = [];
  const fresh: Item[] = [];
  for (const it of items) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (!m) {
      if (it.newAllowed) fresh.push(it);
      continue;
    }
    const r = retrievability(m, o.now);
    if (isDue(m, o.endMs)) due.push({ it, r });
    else if (r < STEADY_FROM) weak.push({ it, r });
  }
  const byR = (a: { it: Item; r: number }, b: { it: Item; r: number }) => a.r - b.r || cmp(a.it.cardId, b.it.cardId) || cmp(a.it.subId, b.it.subId);
  fresh.sort((a, b) => b.boardMs - a.boardMs || cmp(a.boardId, b.boardId) || a.order - b.order || cmp(a.cardId, b.cardId) || a.idx - b.idx);
  const out = (reason: QueueItem['reason'], it: Item): QueueItem => ({ cardId: it.cardId, boardId: it.boardId, subId: it.subId || null, reason, mode: it.mode });
  const all = [
    ...due.sort(byR).map(({ it }) => out('due', it)),
    ...fresh.slice(0, Math.max(0, o.newBudget)).map((it) => out('new', it)),
    ...weak.sort(byR).map(({ it }) => out('weak', it)),
  ];
  return o.limit === undefined ? all : all.slice(0, o.limit);
}

const queueFor = async (tx: Tx, userId: string, boardId: string | null, opts: { now: Date; limit?: number }) => {
  const [cards, states, win, plan, [pref]] = await Promise.all([
    loadCards(tx, userId, boardId), loadStates(tx, userId, null), dayWindow(tx, userId, opts.now), planOf(userId, opts.now), // F08: newCardsPerDay by plan (P-027)
    tx.execute<{ n: number | null }>(sql`select new_cards_per_day as n from user_preferences where user_id = ${userId}`), // F13 D-122: the user's choice, capped by the plan
  ]);
  // the daily limit is global, also for a board queue: count states first attempted today across all boards
  let introduced = 0;
  for (const s of states.values()) if (s.createdMs >= win.startMs) introduced++;
  const ids = boardId ? new Set(cards.map((c) => c.id)) : null;
  const scoped = ids ? new Map([...states].filter(([, s]) => ids.has(s.cardId))) : states;
  return buildQueue(itemsOf(cards, boardId !== null), scoped, { now: opts.now, endMs: win.endMs, newBudget: effectiveNewCardsPerDay(pref?.n ?? null, PLAN_LIMITS[plan.plan].newCardsPerDay) - introduced, limit: opts.limit });
};

export const getDailyQueue: GetDailyQueue = async (userId, opts) => ok(await run(userId, (tx) => queueFor(tx, userId, null, opts)));

export const getBoardQueue: GetBoardQueue = async (userId, boardId, opts) => {
  if (!idSchema.safeParse(boardId).success) return err('not_found', 'board not found');
  return run(userId, async (tx) => {
    const [b] = await tx.execute<{ id: string }>(sql`select id from boards where id = ${boardId}`);
    return b ? ok(await queueFor(tx, userId, boardId, opts)) : err<QueueItem[]>('not_found', 'board not found');
  });
};

/**
 * FR-8 + G01, one pass over the user's cards/states (D-058: computed on read, no job). Per board: due items today (same rule as the
 * queue), card-level state counts and the graph thumbnail (<= PREVIEW_MAX_NODES cards by order, positions in the bounding box of
 * all live cards, same span for x and y so the aspect ratio is kept).
 */
export async function boardListExtras(tx: Tx, userId: string, now: Date, boardIds: string[]) {
  const [cards, states, win] = await Promise.all([loadCards(tx, userId, null), loadStates(tx, userId, null), dayWindow(tx, userId, now)]);
  const edgeRows = boardIds.length
    ? await tx.execute<{ board_id: string; from_card_id: string; to_card_id: string }>(
        sql`select e.board_id, e.from_card_id, e.to_card_id from edges e join cards f on f.id = e.from_card_id and f.deleted_at is null join cards t on t.id = e.to_card_id and t.deleted_at is null where e.board_id = any(${`{${boardIds.join(',')}}`}::uuid[])`,
      )
    : [];
  const out = new Map<string, { dueCount: number; stateCounts: Record<MapState, number>; preview: BoardSummary['preview'] }>();
  const of = (id: string) => {
    let o = out.get(id);
    if (!o) out.set(id, (o = { dueCount: 0, stateCounts: { review: 0, watch: 0, steady: 0, unknown: 0 }, preview: { nodes: [], edges: [] } }));
    return o;
  };
  for (const it of itemsOf(cards, false)) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (m && isDue(m, win.endMs)) of(it.boardId).dueCount++;
  }
  const byBoard = new Map<string, CardRow[]>();
  for (const c of cards) byBoard.set(c.boardId, [...(byBoard.get(c.boardId) ?? []), c]);
  for (const [boardId, list] of byBoard) {
    const o = of(boardId);
    list.sort((a, b) => a.order - b.order || cmp(a.id, b.id));
    const st = list.map((c) => cardState(c, states, now).state);
    for (const s of st) o.stateCounts[s]++;
    const xs = list.map((c) => c.x);
    const ys = list.map((c) => c.y);
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    const span = Math.max(1, Math.max(...xs) - minX, Math.max(...ys) - minY);
    const shown = list.slice(0, PREVIEW_MAX_NODES);
    const idx = new Map(shown.map((c, i) => [c.id, i]));
    o.preview.nodes = shown.map((c, i) => ({ x: (c.x - minX) / span, y: (c.y - minY) / span, state: st[i]! }));
    for (const e of edgeRows) {
      const [i, j] = [idx.get(e.from_card_id), idx.get(e.to_card_id)];
      if (e.board_id === boardId && i !== undefined && j !== undefined) o.preview.edges.push([i, j]);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * G01 "Hoje": items due per study-day offset (0 = today incl. overdue, same rule as the queue's `due`; k = k days ahead), offsets 0..days-1.
 * ponytail: fixed 24 h day buckets; wrong by 1 h across a DST change (BR has none). Use dayWindow per offset if that matters.
 */
export async function dueByOffset(tx: Tx, userId: string, win: { endMs: number }, days: number) {
  const [cards, states] = await Promise.all([loadCards(tx, userId, null), loadStates(tx, userId, null)]);
  const out = Array<number>(days).fill(0);
  for (const it of itemsOf(cards, false)) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (!m) continue;
    const k = isDue(m, win.endMs) ? 0 : Math.floor((m.due.getTime() - win.endMs) / DAY_MS) + 1;
    if (k < days) out[k]!++;
  }
  return out;
}

/** F07: live cards and reviewed-card recall per board (same loaders and per-card state rule as the map). */
export async function boardCardStats(tx: Tx, userId: string, now: Date) {
  const [cards, states] = await Promise.all([loadCards(tx, userId, null), loadStates(tx, userId, null)]);
  const out = new Map<string, { cards: number; recalls: number[] }>();
  for (const c of cards) {
    const o = out.get(c.boardId) ?? out.set(c.boardId, { cards: 0, recalls: [] }).get(c.boardId)!;
    o.cards++;
    const s = cardState(c, states, now);
    if (s.state !== 'unknown') o.recalls.push(s.r);
  }
  return out;
}

// --- retrievability map (FR-7) ----------------------------------------------------------------------------------

const unreviewed = { r: 0, state: 'unknown' as MapState };

/** Per-card map state (D-057): concept/case from its '' state; flow/image = aggregate of steps/masks; no state = unknown. Single rule for the map and the list. */
function cardState(c: CardRow, states: Map<string, StateRow>, now: Date) {
  let earliest: Date | null = null;
  const one = (subId: string): { r: number; state: MapState } => {
    const m = states.get(stateKey(c.id, subId));
    if (!m) return unreviewed;
    if (!earliest || m.due < earliest) earliest = m.due;
    return { r: retrievability(m, now), state: mapState(m, now) };
  };
  if (c.type === 'flow' || c.type === 'image') {
    const subs = Object.fromEntries(c.subs.map((id) => [id, one(id)]));
    const agg = c.subs.length ? aggregate(Object.values(subs)) : unreviewed;
    return { ...agg, due: earliest, subs };
  }
  return { ...one(''), due: earliest };
}

export async function computeRetrievability(userId: string, boardId: string, now: Date) {
  if (!idSchema.safeParse(boardId).success) return err<RetrievabilityMap>('not_found', 'board not found');
  return run(userId, async (tx) => {
    const [b] = await tx.execute<{ id: string }>(sql`select id from boards where id = ${boardId}`);
    if (!b) return err<RetrievabilityMap>('not_found', 'board not found');
    const cards = await loadCards(tx, userId, boardId);
    const states = await loadStates(tx, userId, cards.map((c) => c.id));
    const map: RetrievabilityMap = {};
    for (const c of cards) map[c.id] = cardState(c, states, now);
    return ok(map);
  });
}

// ponytail: in-process cache, correct for a single API instance only (a recordAttempt on another instance leaves a stale map for <= 60 s).
// Upgrade to a shared cache (Redis) or drop it when the API scales out.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; nowMs: number; map: RetrievabilityMap }>();
export const invalidateRetrievability = (userId: string) => {
  for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k);
};

export const getRetrievability: GetRetrievability = async (userId, boardId, now) => {
  const key = `${userId}|${boardId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && Math.abs(now.getTime() - hit.nowMs) < TTL_MS) return ok(hit.map);
  const r = await computeRetrievability(userId, boardId, now);
  if (r.ok) cache.set(key, { at: Date.now(), nowMs: now.getTime(), map: r.data });
  return r;
};
