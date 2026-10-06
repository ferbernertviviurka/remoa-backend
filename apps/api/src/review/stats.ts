import { sql, type SQL } from 'drizzle-orm';
import type { MapState } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm, run } from '../db';
import { active, cardState, isDue, itemsOf, cardsSql, statesSql, stateKey, toCardRow, toStates, uuids, windowSql, type CardRow, type CardSqlRow, type StateRow, type StateSqlRow } from './queue';

/**
 * G21 FR-23 / CCR-055 (D-1029/D-1030): reads of `map_stats`. Triggers (migration 0034) mark a row stale in the transaction of every write
 * that changes it; recall states also drift with the clock, so a row is served while its `day_end` is the reader's study-day end and
 * now < `stale_at`. Otherwise this module recomputes just that board (cards_board_idx + states by card PK) and writes the row back.
 */
export type MapStat = { cards: number; notes: number; edges: number; states: Record<MapState, number>; due: number; reviewed: number; rSum: number };

const PRECISION_MS = 60_000; // ponytail: a state change is noticed up to 1 min late (the L1 cache is 30 s anyway); bisection keeps it O(cards * 11)
const zero = (): MapStat => ({ cards: 0, notes: 0, edges: 0, states: { review: 0, watch: 0, steady: 0, unknown: 0 }, due: 0, reviewed: 0, rSum: 0 });

/** Pure: one board from its in-scope cards (notes included) and the user's states. Same rules as the map, the queue's `due` and coverage. */
export function boardStat(cards: CardRow[], states: Map<string, StateRow>, now: Date, endMs: number, edges: number): MapStat {
  const o = zero();
  o.edges = edges;
  const studied = cards.filter((c) => c.type !== 'note');
  o.notes = cards.length - studied.length;
  o.cards = studied.length;
  for (const c of studied) {
    const s = cardState(c, states, now);
    o.states[s.state]++;
    if (s.state !== 'unknown') {
      o.reviewed++;
      o.rSum += s.r;
    }
  }
  for (const it of itemsOf(active(studied), false)) {
    const m = states.get(stateKey(it.cardId, it.subId));
    if (m && isDue(m, endMs)) o.due++;
  }
  o.rSum = Math.round(o.rSum * 1e8) / 1e8; // each r is already round8; this drops the float noise of the sum so the stored row reads back equal
  return o;
}

/**
 * First moment in (now, endMs] at which some card shows another state (to PRECISION_MS). Valid because a card's state only gets worse
 * with time while nothing is written (recall decreases; due passes): "some card differs from now" is monotone, so bisection finds it.
 * Nothing changes before the end of the study day -> endMs (the day check refreshes the row then anyway).
 */
export function nextChange(cards: CardRow[], states: Map<string, StateRow>, now: Date, endMs: number): number {
  const seen = cards.filter((c) => c.type !== 'note' && c.subs.some((sub) => states.has(stateKey(c.id, sub))));
  const base = seen.map((c) => cardState(c, states, now).state);
  const changed = (t: number) => seen.some((c, i) => cardState(c, states, new Date(t)).state !== base[i]);
  let lo = now.getTime();
  let hi = endMs;
  if (hi <= lo || !changed(hi)) return Math.max(hi, lo + PRECISION_MS);
  while (hi - lo > PRECISION_MS) {
    const mid = Math.floor((lo + hi) / 2);
    if (changed(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

type StoredRow = {
  board_id: string; cards: number; notes: number; edges: number; review: number; watch: number; steady: number; unknown: number; due: number;
  reviewed: number; r_sum: number; version: number; fresh: boolean;
};
const fromRow = (r: StoredRow): MapStat => ({
  cards: r.cards, notes: r.notes, edges: r.edges, states: { review: r.review, watch: r.watch, steady: r.steady, unknown: r.unknown }, due: r.due, reviewed: r.reviewed, rSum: r.r_sum,
});
/** What `mapStatsSql` returns: the stored rows (with `fresh`), and for the boards without a fresh row their cards, states and edge counts. */
export type MapStatsData = { rows: StoredRow[]; cards: CardSqlRow[]; states: StateSqlRow[]; edges: { board_id: string; n: number }[]; end_ms: number };

/**
 * G21 P-482 (D-1045): ONE scalar expression (json) with everything `mapStatsFor` needs: the stored rows of `ids` (a uuid[] expression)
 * and, for the stale/missing ones, the recompute inputs (was read + window + cards/edges + states = 4 statements). Embeddable in a
 * bigger statement (hub). `end` = the study-day end (ms) as SQL; freshness is decided here only, so JS never lacks the data it needs.
 */
export const mapStatsSql = (userId: string, ids: SQL, nowMs: number, end: SQL) => sql`(
  with st as (
    select board_id, cards, notes, edges, review, watch, steady, unknown, due, reviewed, r_sum, version,
      coalesce(stale_at is not null and day_end is not null and round(extract(epoch from day_end) * 1000) = ${end}
        and extract(epoch from stale_at) * 1000 > ${nowMs}::float8, false) as fresh
    from map_stats where user_id = ${userId} and board_id = any(${ids})),
  cold as (select x.id from unnest(${ids}) as x(id) where not exists (select 1 from st where st.board_id = x.id and st.fresh)),
  cc as (${cardsSql(userId, sql`c.board_id = any(array(select id from cold))`, true)})
  select json_build_object(
    'rows', (select coalesce(json_agg(st), '[]') from st),
    'cards', (select coalesce(json_agg(cc), '[]') from cc),
    'states', (select coalesce(json_agg(f), '[]') from (${statesSql(userId, sql`and card_id = any(array(select id from cc))`)}) f),
    'edges', (select coalesce(json_agg(e), '[]') from (
      select e.board_id, count(*)::int as n from edges e where e.board_id = any(array(select id from cold))
        and not exists (select 1 from cards d where d.id in (e.from_card_id, e.to_card_id) and d.deleted_at is not null) group by 1) e),
    'end_ms', ${end}))`;

/**
 * Stats per board for the user (any board ids: unknown or unreadable ones come back as zeros and are not stored).
 * One statement reads the rows and the recompute inputs of the stale ones (same snapshot); a write committed after it bumps `version`,
 * so the upsert below (`where version = what we read`) loses and the row stays stale for the next reader instead of holding pre-write numbers.
 * Without `win` the study day is computed in the same statement. Cost: 1 statement, +1 (the upsert) when something was stale.
 */
export async function mapStatsFor(tx: Tx, userId: string, boardIds: readonly string[], now = new Date(), win?: { endMs: number }): Promise<Map<string, MapStat>> {
  const ids = [...new Set(boardIds)];
  if (!ids.length) return new Map();
  const [r] = await tx.execute<{ m: MapStatsData }>(win
    ? sql`select ${mapStatsSql(userId, uuids(ids), now.getTime(), sql`${win.endMs}::float8`)} as m`
    : sql`with w as (${windowSql(userId, now)}) select ${mapStatsSql(userId, uuids(ids), now.getTime(), sql`round((select end_ms from w))`)} as m`);
  return mapStatsFrom(tx, userId, ids, r!.m, now);
}

/** Finishes `mapStatsSql`: fresh rows as stored, the rest recomputed (pure) and written back in one upsert. */
export async function mapStatsFrom(tx: Tx, userId: string, ids: readonly string[], d: MapStatsData, now: Date): Promise<Map<string, MapStat>> {
  const out = new Map<string, MapStat>();
  const stored = new Map(d.rows.map((r) => [r.board_id, r]));
  const todo = ids.filter((id) => !stored.get(id)?.fresh);
  for (const id of ids) if (!todo.includes(id)) out.set(id, fromRow(stored.get(id)!));
  if (!todo.length) return out;
  const endMs = Math.round(d.end_ms);
  const states = toStates(d.states);
  const withState = new Set([...states.values()].map((x) => x.cardId));
  const edges = new Map(d.edges.map((e) => [e.board_id, e.n]));
  const byBoard = new Map<string, CardRow[]>(todo.map((id) => [id, []]));
  for (const c of d.cards.map(toCardRow)) if (c.own || withState.has(c.id)) byBoard.get(c.boardId)?.push(c);
  const recs = [...byBoard].map(([id, list]) => {
    const st = boardStat(list, states, now, endMs, edges.get(id) ?? 0);
    out.set(id, st);
    return {
      board_id: id, cards: st.cards, notes: st.notes, edges: st.edges, review: st.states.review, watch: st.states.watch, steady: st.states.steady, unknown: st.states.unknown,
      due: st.due, reviewed: st.reviewed, r_sum: st.rSum, stale_ms: nextChange(list, states, now, endMs), version: stored.get(id)?.version ?? 0,
    };
  });
  await tx.execute(sql`
    insert into map_stats as m (user_id, board_id, cards, notes, edges, review, watch, steady, unknown, due, reviewed, r_sum, day_end, stale_at, version)
    select ${userId}, v.board_id, v.cards, v.notes, v.edges, v.review, v.watch, v.steady, v.unknown, v.due, v.reviewed, v.r_sum,
      to_timestamp(${endMs}::float8 / 1000), to_timestamp(v.stale_ms / 1000), v.version
    from jsonb_to_recordset(${JSON.stringify(recs)}::jsonb) as v(board_id uuid, cards int, notes int, edges int, review int, watch int, steady int, unknown int,
      due int, reviewed int, r_sum float8, stale_ms float8, version int)
    where exists (select 1 from boards b where b.id = v.board_id)
    on conflict (user_id, board_id) do update set cards = excluded.cards, notes = excluded.notes, edges = excluded.edges, review = excluded.review,
      watch = excluded.watch, steady = excluded.steady, unknown = excluded.unknown, due = excluded.due, reviewed = excluded.reviewed, r_sum = excluded.r_sum,
      day_end = excluded.day_end, stale_at = excluded.stale_at, updated_at = now()
    where m.version = excluded.version`);
  return out;
}

/** Hub/coverage scope: the user's non-archived boards plus other users' boards the user studies (rows the fsrs_state trigger created). */
export const scopeBoards = (tx: Tx, userId: string) => tx.execute<ScopeBoard>(scopeBoardsSql(userId));
export type ScopeBoard = { id: string; title: string; area: CardRow['area']; own: boolean };
export const scopeBoardsSql = (userId: string) => sql`
    select b.id, b.title, b.area::text as area, true as own from boards b where b.user_id = ${userId} and b.archived_at is null
    union
    select b.id, b.title, b.area::text, false from map_stats m join boards b on b.id = m.board_id where m.user_id = ${userId} and b.user_id <> ${userId} and b.archived_at is null`;

/**
 * Own non-archived boards: live cards, notes and connections (onboarding, entitlements). Counts change only by writes, and every write
 * nulls `stale_at`, so a row with `stale_at` set has right counts even after its clock expiry: the common case is this one indexed
 * statement (server connection, filtered by user); only boards whose row is missing or invalidated are recomputed.
 */
export async function ownTotals(userId: string, now = new Date()) {
  const { db } = await dbm();
  const [r] = await db.execute<{ cards: number; notes: number; edges: number; missing: number }>(sql`
    select coalesce(sum(m.cards), 0)::int as cards, coalesce(sum(m.notes), 0)::int as notes, coalesce(sum(m.edges), 0)::int as edges,
      (count(*) filter (where m.stale_at is null))::int as missing
    from boards b left join map_stats m on m.board_id = b.id and m.user_id = b.user_id
    where b.user_id = ${userId} and b.archived_at is null`);
  if (r && !r.missing) return { cards: r.cards, notes: r.notes, edges: r.edges };
  return run(userId, async (tx) => {
    const ids = await tx.execute<{ id: string }>(sql`select id from boards where user_id = ${userId} and archived_at is null`);
    const t = { cards: 0, notes: 0, edges: 0 };
    for (const s of (await mapStatsFor(tx, userId, ids.map((x) => x.id), now)).values()) {
      t.cards += s.cards;
      t.notes += s.notes;
      t.edges += s.edges;
    }
    return t;
  });
}

/**
 * Job `stats.rebuild` (idempotent): rebuilds one user's rollups from scratch. Daily stats from `attempts` (SQL function, locked against
 * the attempts trigger); map_stats: every in-scope board marked stale and recomputed now (creates the rows of boards studied before 0034).
 */
export async function rebuildUserStats(userId: string, now = new Date()) {
  const { db } = await dbm();
  const [d] = await db.execute<{ n: number }>(sql`select public.rebuild_user_daily_stats(${userId}::uuid) as n`);
  const boards = await run(userId, async (tx) => {
    const ids = await tx.execute<{ id: string }>(sql`
      select id from boards where user_id = ${userId}
      union select distinct c.board_id from fsrs_state f join cards c on c.id = f.card_id where f.user_id = ${userId}`);
    await tx.execute(sql`update map_stats set version = version + 1, stale_at = null, updated_at = now() where user_id = ${userId}`);
    await mapStatsFor(tx, userId, ids.map((r) => r.id), now);
    return ids.length;
  });
  return { days: d?.n ?? 0, boards };
}

/**
 * All users, in keyset batches (FR-29: the backfill of 0034 runs here, not in the migration). Each user is its own transaction.
 * ponytail: sequential; fan out one Inngest step per batch when there are more users than one cron run can take.
 */
export async function rebuildAllStats(now: Date, batch = 100) {
  const { db } = await dbm();
  let after = '00000000-0000-0000-0000-000000000000';
  let users = 0;
  for (;;) {
    const rows = await db.execute<{ user_id: string }>(sql`select user_id from profiles where user_id > ${after}::uuid order by user_id limit ${batch}`);
    for (const r of rows) await rebuildUserStats(r.user_id, now);
    users += rows.length;
    if (rows.length < batch) return { users };
    after = rows[rows.length - 1]!.user_id;
  }
}
