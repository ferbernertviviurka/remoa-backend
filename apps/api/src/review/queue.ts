import { sql, type SQL } from 'drizzle-orm';
import {
  PLAN_LIMITS, PREVIEW_MAX_NODES, cacheTags, REVIEW_HUB_AHEAD_DAYS, type Area, type QueueFilter, effectiveNewCardsPerDay, err, idSchema, ok, type ChallengeMode, type CardType, type FsrsCardState, type FsrsMemory, type GetBoardQueue,
  type BoardSummary, type GetDailyQueue, type GetRetrievability, type MapState, type QueueItem, type RetrievabilityMap,
} from '@remoa/contracts';
import { aggregate, CURVE, mapState, retrievability, STEADY_FROM } from '@remoa/fsrs';
import type { Tx } from '@remoa/db';
import { run } from '../db';
import { cached, type UserCacheDef } from '../cache';
import { planOf } from '../billing/plan';

const ROLLOVER_HOUR = 4; // FRD: the study day rolls over at 04:00 local
const DEFAULT_TZ = 'America/Sao_Paulo';
const MODE: Record<CardType, ChallengeMode> = { concept: 'hidden_card', case: 'case', flow: 'next_step', image: 'occlusion', note: 'hidden_card' /* never used: D-200 notes are filtered out in loadCards */ };

export type CardRow = { id: string; boardId: string; area: Area; type: CardType; order: number; boardMs: number; own: boolean; subs: string[]; x: number; y: number; suspended: boolean };
export type StateRow = FsrsMemory & { cardId: string; subId: string; createdMs: number };
export type Item = { cardId: string; boardId: string; subId: string; mode: ChallengeMode; order: number; boardMs: number; idx: number; newAllowed: boolean };

export const stateKey = (cardId: string, subId: string) => `${cardId}\u0000${subId}`;
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
export const isDue = (m: FsrsMemory, endMs: number) => m.due.getTime() < endMs;

// --- loading (set-based: one query for cards, one for states) ---------------------------------------------------

const subIds = (key: 'steps' | 'masks') => sql`case when jsonb_typeof(c.payload->${key}::text) = 'array' then coalesce((
  select jsonb_agg(x->>'id' order by ord) from jsonb_array_elements(c.payload->${key}::text) with ordinality t(x, ord) where jsonb_typeof(x) = 'object' and x->>'id' is not null
), '[]'::jsonb) else '[]'::jsonb end`;

export const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * RLS (withUser) decides what is readable. `boardId` null = daily scope: live cards of non-archived boards the user owns or has study
 * state on; a list = those boards (no ownership rule). G21 FR-22 (D-1027): the daily scope first narrows to the boards of the two indexed
 * sources (`boards.user_id`, `fsrs_state.user_id`), so cards are read by `cards.board_id`; the plain `b.user_id = $u or exists(fsrs_state)`
 * could not use an index and scanned every card of the database (13 s per call in the baseline).
 */
export async function loadCards(tx: Tx, userId: string, boardId: string | readonly string[] | null, withNotes = false): Promise<CardRow[]> {
  // `= any(array(subquery))` is an index condition on cards.board_id; a join or an OR here let the planner seq-scan cards under RLS
  const scope = boardId === null
    ? sql`b.archived_at is null and c.board_id = any(array(
        select id from boards where user_id = ${userId} and archived_at is null
        union select c3.board_id from fsrs_state s join cards c3 on c3.id = s.card_id where s.user_id = ${userId}))
      and (b.user_id = ${userId} or exists (select 1 from fsrs_state s where s.user_id = ${userId} and s.card_id = c.id))`
    : typeof boardId === 'string' ? sql`c.board_id = ${boardId}` : sql`c.board_id = any(${uuids(boardId)})`;
  return (await tx.execute<CardSqlRow>(cardsSql(userId, scope, withNotes))).map(toCardRow);
}

export type CardSqlRow = { id: string; board_id: string; type: CardType; order: number; board_ms: number; own: boolean; subs: string[]; x: number; y: number; suspended: boolean; area: Area };
/** The statement of loadCards for a ready `where` fragment over `c` (cards) and `b` (boards); rows go through `toCardRow`. */
export const cardsSql = (userId: string, scope: SQL, withNotes: boolean) => sql`
    select (c.suspended_at is not null) as suspended, b.area::text as area, c.id, c.board_id, c.type, c."order", c.x, c.y, (extract(epoch from b.updated_at) * 1000)::float8 as board_ms, (b.user_id = ${userId}) as own,
      case c.type when 'flow' then ${subIds('steps')} when 'image' then ${subIds('masks')} else '[""]'::jsonb end as subs
    from cards c join boards b on b.id = c.board_id
    where c.deleted_at is null and (${withNotes}::boolean or c.type <> 'note') and ${scope}`; // D-200: notes are never scheduled, counted, or in the recall map (absent = no state); only the Hoje thumbnail asks for them (D-334)
export const toCardRow = (r: CardSqlRow): CardRow => ({ id: r.id, boardId: r.board_id, type: r.type, order: r.order, boardMs: r.board_ms, own: r.own, subs: r.subs, x: r.x, y: r.y, suspended: r.suspended, area: r.area });

/**
 * `cardIds` null = every state of the user. Scoping by ids (PK lookups) instead of a subquery on `cards`: the cards RLS
 * subquery isn't leakproof, so `card_id in (select … from cards)` planned as a nested loop (~200 ms for 500 cards).
 */
export async function loadStates(tx: Tx, userId: string, cardIds: string[] | null) {
  return toStates(await tx.execute<StateSqlRow>(statesSql(userId, cardIds ? sql`and card_id = any(${uuids(cardIds)})` : sql``)));
}

export type StateSqlRow = {
  card_id: string; sub_id: string; stability: number; difficulty: number; due_ms: number; reps: number; lapses: number;
  last_ms: number | null; state: FsrsCardState; learning_steps: number; scheduled_days: number; created_ms: number;
};
export const statesSql = (userId: string, scope: SQL) => sql`
    select card_id, sub_id, stability, difficulty, (extract(epoch from due) * 1000)::float8 as due_ms, reps, lapses,
      (extract(epoch from last_review) * 1000)::float8 as last_ms, state, learning_steps, scheduled_days,
      (extract(epoch from created_at) * 1000)::float8 as created_ms
    from fsrs_state where user_id = ${userId} ${scope}`;
export function toStates(rows: Iterable<StateSqlRow>) {
  return new Map<string, StateRow>(
    [...rows].map((r) => [
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
  // G21 P-480 (D-1044): one statement (profile tz read inline). ponytail: profile.timezone is validated on write (ianaTimezoneSchema);
  // an invalid stored name would make `at time zone` raise, so there is no JS fallback any more except for a missing profile.
  return toWindow((await tx.execute<WindowSqlRow>(windowSql(userId, now)))[0]!);
}
export type WindowSqlRow = { start_ms: number; end_ms: number; day: string; tz: string };
export const toWindow = (w: WindowSqlRow) => ({ startMs: Math.round(w.start_ms), endMs: Math.round(w.end_ms), day: w.day, tz: w.tz });
/** The statement of dayWindow (one row: tz, day, start_ms, end_ms); embeddable as a CTE. */
export const windowSql = (userId: string, now: Date) => sql`
    with z as (select coalesce((select timezone from profiles where user_id = ${userId}), ${DEFAULT_TZ}::text) as tz),
    l as (select z.tz, ((${now.toISOString()}::timestamptz at time zone z.tz) - make_interval(hours => ${ROLLOVER_HOUR}))::date as d from z)
    select l.tz, l.d::text as day, (extract(epoch from ((l.d + time '04:00') at time zone l.tz)) * 1000)::float8 as start_ms,
           (extract(epoch from (((l.d + 1) + time '04:00') at time zone l.tz)) * 1000)::float8 as end_ms from l`;

/** D-057: concept/case = the card; flow = one item per step; image = one per mask. */
export const itemsOf = (cards: CardRow[], boardScope: boolean): Item[] =>
  cards.flatMap((c) =>
    c.subs.map((subId, idx) => ({
      cardId: c.id, boardId: c.boardId, subId, mode: MODE[c.type], order: c.order, boardMs: c.boardMs, idx, newAllowed: boardScope || c.own,
    })),
  );

// --- pure queue rule (FR-6): the reference. The served queue is the SQL below (D-1027); review.test.ts checks both give the same list --

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

export const active = (cards: CardRow[]) => cards.filter((c) => !c.suspended); // F03 FR-9 (D-522): suspended cards stay on the map but are never queued or counted as due

/** G15 "Adiantar revisões" (Q-034): items not due today but due within REVIEW_HUB_AHEAD_DAYS, soonest first. Does not touch the schedule. */
export function aheadItems(items: Item[], states: Map<string, StateRow>, endMs: number): QueueItem[] {
  const max = endMs + REVIEW_HUB_AHEAD_DAYS * DAY_MS;
  return items
    .flatMap((it) => {
      const m = states.get(stateKey(it.cardId, it.subId));
      return m && !isDue(m, endMs) && m.due.getTime() < max ? [{ it, at: m.due.getTime() }] : [];
    })
    .sort((a, b) => a.at - b.at || cmp(a.it.cardId, b.it.cardId) || cmp(a.it.subId, b.it.subId))
    .map(({ it }) => ({ cardId: it.cardId, boardId: it.boardId, subId: it.subId || null, reason: 'due' as const, mode: it.mode }));
}

// --- the served queue: indexed SQL with limits, no card scan, no ts-fsrs per item (G21 FR-22, D-1027/D-1028) -----------------------

const DAY_MS = 86_400_000;
const at = (ms: number) => sql`${new Date(ms).toISOString()}::timestamptz`;

/**
 * Recall of the state row `f` at `nowMs`, with the same expression and roundings as @remoa/fsrs `retrievability` (ts-fsrs:
 * round8((1 + factor * floor(elapsed days) / round8(S)) ^ decay); 0 when never reviewed). Used only to order and to pick "em atenção".
 */
export const recallSql = (nowMs: number) => sql`(case when f.reps = 0 or f.last_review is null or f.state = 'new' then 0::float8 else round(power(
  1 + ${CURVE.factor}::float8 * greatest(floor((${nowMs}::float8 - round(extract(epoch from f.last_review) * 1000)) / ${DAY_MS}), 0)
    / greatest(round(f.stability::numeric, 8)::float8, 1e-300), ${CURVE.decay}::float8)::numeric, 8)::float8 end)`;

const arrayOf = (key: 'steps' | 'masks') => sql`(case when jsonb_typeof(c.payload->${key}::text) = 'array' then c.payload->${key}::text else '[]'::jsonb end)`;
/** The state's sub_id is still an item of the card (D-057: '' for concept/case, a current step/mask id otherwise). */
const subAlive = sql`(case c.type
  when 'flow' then exists (select 1 from jsonb_array_elements(${arrayOf('steps')}) as e(v) where jsonb_typeof(e.v) = 'object' and e.v->>'id' = f.sub_id)
  when 'image' then exists (select 1 from jsonb_array_elements(${arrayOf('masks')}) as e(v) where jsonb_typeof(e.v) = 'object' and e.v->>'id' = f.sub_id)
  else f.sub_id = '' end)`;

export type Scope = { userId: string; boardId: string | null; filter?: Pick<QueueFilter, 'boardIds' | 'area'> };
/** Cards (c) and boards (b) an item may come from: the board, or the daily scope (non-archived) narrowed by the Revisar filter. */
const scopeSql = (s: Scope) => sql.join([
  s.boardId ? sql`c.board_id = ${s.boardId}` : sql`b.archived_at is null`,
  ...(s.filter?.boardIds ? [sql`c.board_id = any(${uuids(s.filter.boardIds)})`] : []),
  ...(s.filter?.area ? [sql`b.area = ${s.filter.area}`] : []),
], sql` and `);

/**
 * Items that have a state (due, em atenção, adiantar), live and active (F03 FR-9: suspended ones never queue). Range on `fsrs_state(user_id, due)`,
 * then one PK probe per state into cards and boards: `offset 0` keeps the lateral a per-row lookup (with the RLS filter of cards the planner
 * otherwise picked a hash join over a seq scan of every card).
 */
const stateItemsSql = (s: Scope, where: SQL) => sql`
  from fsrs_state f
  cross join lateral (select c.id, c.board_id, c.type, c.payload, c.deleted_at, c.suspended_at from cards c where c.id = f.card_id offset 0) c
  cross join lateral (select b.id, b.area, b.archived_at from boards b where b.id = c.board_id offset 0) b
  where f.user_id = ${s.userId} and c.deleted_at is null and c.suspended_at is null and c.type <> 'note' and ${scopeSql(s)} and ${subAlive} and ${where}`;

/** New items: live, active cards of the user's own boards (or of the board) whose step/mask has no state yet. */
const freshSql = (s: Scope) => sql`
  select c.id as card_id, c.board_id, c.type, sx.sub_id, sx.ord, c."order" as ord_card, (extract(epoch from b.updated_at) * 1000)::float8 as board_ms,
    row_number() over (partition by c.board_id order by c."order", c.id, sx.ord) as board_rank
  from boards b join cards c on c.board_id = b.id
  cross join lateral (
    select '' as sub_id, 0::bigint as ord where c.type in ('concept', 'case')
    union all
    select e.v->>'id', e.ord from jsonb_array_elements(case c.type when 'flow' then ${arrayOf('steps')} when 'image' then ${arrayOf('masks')} else '[]'::jsonb end) with ordinality as e(v, ord)
    where jsonb_typeof(e.v) = 'object' and e.v->>'id' is not null
  ) sx
  where c.deleted_at is null and c.suspended_at is null and c.type <> 'note' and ${scopeSql(s)}
    and ${s.boardId ? sql`true` : sql`b.user_id = ${s.userId} and c.board_id = any(array(select id from boards where user_id = ${s.userId} and archived_at is null))`}
    and not exists (select 1 from fsrs_state f where f.user_id = ${s.userId} and f.card_id = c.id and f.sub_id = sx.sub_id)`;

type Row = { g: 'due' | 'new' | 'weak' | 'ahead'; card_id: string; board_id: string; type: CardType; sub_id: string; r: number; due_ms: number; ord: number; ord_card: number; board_ms: number };
const lim = (n: number | null) => (n === null ? sql`` : sql`limit ${n}`);
const cmpR = (a: Row, b: Row) => a.r - b.r || cmp(a.card_id, b.card_id) || cmp(a.sub_id, b.sub_id); // the reference comparator (byR)
const cmpFresh = (a: Row, b: Row) => b.board_ms - a.board_ms || cmp(a.board_id, b.board_id) || a.ord_card - b.ord_card || cmp(a.card_id, b.card_id) || a.ord - b.ord;
const toItem = (reason: QueueItem['reason']) => (r: Row): QueueItem => ({ cardId: r.card_id, boardId: r.board_id, subId: r.sub_id || null, reason, mode: MODE[r.type] });

/**
 * One statement: each group is an index range with its own `limit` (null = all, false = skip). SQL picks the rows; JS orders them with
 * the reference comparators (same tie-breaks as `buildQueue`). `fresh.perBoard` caps new items per board (the hub).
 */
export async function queueRows(tx: Tx, s: Scope, o: QueueOpts) {
  const q = queueRowsSql(s, o);
  return sortQueueRows(q ? await tx.execute<QueueSqlRow>(q) : []);
}
type QueueOpts = {
  now: Date; endMs: number; due: number | null | false; weak: number | null | false; fresh: { limit: number | null; perBoard: number | null } | false; ahead?: number | null;
};
export type QueueSqlRow = Row;
/** The statement of queueRows (null = no group asked); rows go through `sortQueueRows`. */
export function queueRowsSql(s: Scope, o: QueueOpts): SQL | null {
  const nowMs = o.now.getTime();
  const r = recallSql(nowMs);
  const cols = sql`f.card_id, c.board_id, c.type, f.sub_id, ${r} as r, round(extract(epoch from f.due) * 1000)::float8 as due_ms, 0::bigint as ord, 0 as ord_card, 0::float8 as board_ms`;
  const parts: SQL[] = [];
  if (o.ahead !== undefined) parts.push(sql`(select 'ahead' as g, ${cols} ${stateItemsSql(s, sql`f.due >= ${at(o.endMs)} and f.due < ${at(o.endMs + REVIEW_HUB_AHEAD_DAYS * DAY_MS)}`)} order by f.due, f.card_id, f.sub_id collate "C" ${lim(o.ahead)})`);
  if (o.due !== false) parts.push(sql`(select 'due' as g, ${cols} ${stateItemsSql(s, sql`f.due < ${at(o.endMs)}`)} order by r, f.card_id, f.sub_id collate "C" ${lim(o.due)})`);
  if (o.weak !== false) parts.push(sql`(select 'weak' as g, ${cols} ${stateItemsSql(s, sql`f.due >= ${at(o.endMs)} and ${r} < ${STEADY_FROM}`)} order by r, f.card_id, f.sub_id collate "C" ${lim(o.weak)})`);
  if (o.fresh !== false) parts.push(sql`(select 'new' as g, card_id, board_id, type, sub_id, 0::float8 as r, 0::float8 as due_ms, ord, ord_card, board_ms from (${freshSql(s)}) n
    ${o.fresh.perBoard === null ? sql`` : sql`where board_rank <= ${o.fresh.perBoard}`} order by board_ms desc, board_id, ord_card, card_id, ord ${lim(o.fresh.limit)})`);
  return parts.length ? sql.join(parts, sql` union all `) : null;
}
export function sortQueueRows(rows: readonly Row[]) {
  const of = (g: Row['g']) => rows.filter((x) => x.g === g);
  return {
    due: of('due').sort(cmpR).map(toItem('due')),
    new: of('new').sort(cmpFresh).map(toItem('new')),
    weak: of('weak').sort(cmpR).map(toItem('weak')),
    ahead: of('ahead').sort((a, b) => a.due_ms - b.due_ms || cmp(a.card_id, b.card_id) || cmp(a.sub_id, b.sub_id)).map(toItem('due')),
  };
}

/** New-card cap of the day (null = unlimited, D-647) and how many states were first created today, across all boards. */
export async function newCardBudget(tx: Tx, userId: string, plan: Promise<{ plan: keyof typeof PLAN_LIMITS }>, startMs: number) {
  const [[row], p] = await Promise.all([
    tx.execute<{ pref: number | null; introduced: number }>(sql`select (select new_cards_per_day from user_preferences where user_id = ${userId}) as pref,
      (select count(*)::int from fsrs_state where user_id = ${userId} and created_at >= ${at(startMs)}) as introduced`), // F13 D-122: the user's choice, capped by the plan
    plan,
  ]);
  return budgetOf(row, p.plan);
}
export function budgetOf(row: { pref: number | null; introduced: number } | undefined, plan: keyof typeof PLAN_LIMITS) {
  const limit = effectiveNewCardsPerDay(row?.pref ?? null, PLAN_LIMITS[plan].newCardsPerDay);
  return { limit, introduced: row?.introduced ?? 0, remaining: limit === null ? Infinity : Math.max(0, limit - (row?.introduced ?? 0)) };
}

const queueFor = async (tx: Tx, userId: string, boardId: string | null, opts: { now: Date; limit?: number; filter?: QueueFilter }) => {
  const win = await dayWindow(tx, userId, opts.now);
  const f = opts.filter;
  const scope: Scope = { userId, boardId, filter: f };
  const n = opts.limit ?? null;
  if (f?.ahead) return (await queueRows(tx, scope, { now: opts.now, endMs: win.endMs, due: false, weak: false, fresh: false, ahead: n })).ahead;
  const plan = planOf(userId, opts.now); // F08: newCardsPerDay by plan (P-027); other connection, in parallel with the budget query
  const reasons = f ? (f.reasons ?? ['due', 'new']) : null; // G15: scope first (boardIds/area in SQL), so the new-card budget goes to the chosen boards
  const want = (r: QueueItem['reason']) => !reasons || reasons.includes(r);
  const budget = (await newCardBudget(tx, userId, plan, win.startMs)).remaining;
  const newLimit = Math.min(budget, n ?? Infinity);
  const q = await queueRows(tx, scope, {
    now: opts.now, endMs: win.endMs, due: want('due') ? n : false, weak: want('weak') ? n : false,
    fresh: want('new') && newLimit > 0 ? { limit: Number.isFinite(newLimit) ? newLimit : null, perBoard: null } : false,
  });
  const all = [...q.due, ...q.new, ...q.weak];
  return n === null ? all : all.slice(0, n);
};

export const getDailyQueue: GetDailyQueue = async (userId, opts) => ok(await run(userId, (tx) => queueFor(tx, userId, null, opts)));

/** G15 (D-641): the daily queue narrowed by the Revisar chips/boards. Same rule and order as `getDailyQueue`. */
export const getFilteredQueue = async (userId: string, filter: QueueFilter, opts: { now: Date; limit?: number }) => ok(await run(userId, (tx) => queueFor(tx, userId, null, { ...opts, filter })));

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
  const [withNotes, states, win] = await Promise.all([loadCards(tx, userId, null, true), loadStates(tx, userId, null), dayWindow(tx, userId, now)]);
  const cards = withNotes.filter((c) => c.type !== 'note');
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
  for (const it of itemsOf(active(cards), false)) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (m && isDue(m, win.endMs)) of(it.boardId).dueCount++;
  }
  const byBoard = new Map<string, CardRow[]>();
  for (const c of withNotes) byBoard.set(c.boardId, [...(byBoard.get(c.boardId) ?? []), c]);
  for (const [boardId, list] of byBoard) {
    const o = of(boardId);
    list.sort((a, b) => a.order - b.order || cmp(a.id, b.id));
    const st = list.map((c) => (c.type === 'note' ? 'unknown' : cardState(c, states, now).state));
    list.forEach((c, i) => { if (c.type !== 'note') o.stateCounts[st[i]!]++; });
    const xs = list.map((c) => c.x);
    const ys = list.map((c) => c.y);
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    const span = Math.max(1, Math.max(...xs) - minX, Math.max(...ys) - minY);
    // D-334: hubs (notes) first so the thumbnail keeps the hub -> card edges; the rest of a big board is sampled evenly (a straight slice by order showed one corner)
    const pos = new Map(list.map((c, i) => [c, i]));
    const hubs = list.filter((c) => c.type === 'note').slice(0, PREVIEW_MAX_NODES / 4);
    const rest = list.filter((c) => c.type !== 'note');
    const room = PREVIEW_MAX_NODES - hubs.length;
    const picked = rest.length <= room ? rest : Array.from({ length: room }, (_, k) => rest[Math.floor((k * rest.length) / room)]!);
    const shown = [...hubs, ...picked];
    const idx = new Map(shown.map((c, i) => [c.id, i]));
    o.preview.nodes = shown.map((c) => ({ x: (c.x - minX) / span, y: (c.y - minY) / span, state: st[pos.get(c)!]! }));
    for (const e of edgeRows) {
      const [i, j] = [idx.get(e.from_card_id), idx.get(e.to_card_id)];
      if (e.board_id === boardId && i !== undefined && j !== undefined) o.preview.edges.push([i, j]);
    }
  }
  return out;
}

/**
 * G01 "Hoje": items due per study-day offset (0 = today incl. overdue, same rule as the queue's `due`; k = k days ahead), offsets 0..days-1.
 * G21 FR-22: one grouped count over the `fsrs_state(user_id, due)` range (was every card and state of the user).
 * ponytail: fixed 24 h day buckets; wrong by 1 h across a DST change (BR has none). Use dayWindow per offset if that matters.
 */
export async function dueByOffset(tx: Tx, userId: string, win: { endMs: number }, days: number) {
  return days < 1 ? Array<number>(days).fill(0) : dueFrom(await tx.execute<{ k: number; n: number }>(dueByOffsetSql(userId, win, days)), days);
}
export function dueFrom(rows: Iterable<{ k: number; n: number }>, days: number) {
  const out = Array<number>(Math.max(days, 0)).fill(0);
  for (const r of rows) if (r.k >= 0 && r.k < days) out[r.k] = r.n;
  return out;
}
/** The statement of dueByOffset (days >= 1): rows (k, n). */
export const dueByOffsetSql = (userId: string, win: { endMs: number }, days: number) => sql`
    select (case when f.due < ${at(win.endMs)} then 0 else floor((round(extract(epoch from f.due) * 1000) - ${win.endMs}::float8) / ${DAY_MS})::int + 1 end) as k, count(*)::int as n
    ${stateItemsSql({ userId, boardId: null }, sql`f.due < ${at(win.endMs + (days - 1) * DAY_MS)}`)}
    group by 1`;

// --- retrievability map (FR-7) ----------------------------------------------------------------------------------

const unreviewed = { r: 0, state: 'unknown' as MapState };

/** Per-card map state (D-057): concept/case from its '' state; flow/image = aggregate of steps/masks; no state = unknown. Single rule for the map and the list. */
export function cardState(c: CardRow, states: Map<string, StateRow>, now: Date) {
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

// G21 T7: L1 cache of the cache/ module; dropped by map.changed (mapId), card.changed (mapId) and review.answered (`review` tag).
const retrCache = (boardId: string, now: Date): UserCacheDef<{ userId: string }> => ({
  scope: 'user', name: 'retrievability', ttl: 'live', key: () => [boardId, Math.floor(now.getTime() / 60_000)],
  tags: ({ userId }) => [cacheTags.user(userId, 'review'), ...(idSchema.safeParse(boardId).success && !boardId.includes(':') ? [cacheTags.map(userId, boardId)] : [])],
});

export const getRetrievability: GetRetrievability = (userId, boardId, now) => cached(retrCache(boardId, now), { userId }, () => computeRetrievability(userId, boardId, now));
