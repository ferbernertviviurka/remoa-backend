// G21 FR-22/FR-23 (D-1027..D-1031) integration: needs local Supabase with migration 0034 (`pnpm db:migrate`); skipped without DATABASE_URL.
// 1) the indexed SQL queue gives the same items in the same order as the reference rule (old loadCards OR-exists scope + buildQueue);
// 2) after every kind of write, the served rollups equal a rebuild from scratch (stats.rebuild) and an aggregate of `attempts`.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_LIMITS, effectiveNewCardsPerDay, type Attempt, type QueueFilter, type QueueItem } from '@remoa/contracts';
import type { Tx } from '@remoa/db';

config({ path: '../../.env' });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date('2026-06-10T15:00:00Z'); // 12:00 in São Paulo; study day 06-10 07:00Z .. 06-11 07:00Z
const ago = (d: number) => new Date(now.getTime() - d * DAY);

describe.skipIf(!process.env.DATABASE_URL)('G21 queue by index + rollups', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let q: typeof import('./queue');
  let st: typeof import('./stats');
  let db: typeof import('../db');
  let ra: typeof import('./record-attempt');

  const newUser = async (tz = 'America/Sao_Paulo') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dbm.db.update(dbm.profiles).set({ timezone: tz }).where(eq(dbm.profiles.userId, id));
    return id;
  };
  const mkBoard = async (userId: string, o: { updatedAt?: Date; archived?: boolean; status?: 'private' | 'seed_approved' } = {}) => {
    const [b] = await dbm.db.insert(dbm.boards).values({ userId, title: `Mapa ${uuid().slice(0, 4)}`, updatedAt: o.updatedAt ?? now, archivedAt: o.archived ? now : null, status: o.status ?? 'private' }).returning();
    return b!.id;
  };
  const mkCard = async (boardId: string, o: { type?: 'concept' | 'flow' | 'image' | 'case' | 'note'; order?: number; payload?: unknown; suspended?: boolean; deleted?: boolean } = {}) => {
    const [c] = await dbm.db.insert(dbm.cards).values({
      boardId, type: o.type ?? 'concept', title: 'c', order: o.order ?? 0, payload: o.payload ?? {}, suspendedAt: o.suspended ? now : null, deletedAt: o.deleted ? now : null,
    }).returning();
    return c!.id;
  };
  const steps = (ids: string[]) => ({ steps: ids.map((id) => ({ id, text: id })) });
  const masks = (ids: string[]) => ({ masks: ids.map((id) => ({ id, polygon: [] })) });
  const putState = (userId: string, cardId: string, s: { sub?: string; lastReview: Date; stability: number; due: Date; createdAt?: Date; lapses?: number }) =>
    dbm.db.insert(dbm.fsrsState).values({
      userId, cardId, subId: s.sub ?? '', stability: s.stability, difficulty: 5, due: s.due, reps: 3, lapses: s.lapses ?? 0, lastReview: s.lastReview,
      state: 'review', scheduledDays: 5, createdAt: s.createdAt ?? s.lastReview,
    });
  const attempt = (userId: string, cardId: string, o: Partial<Attempt> = {}): Attempt => ({
    id: uuid(), userId, cardId, subId: null, sessionId: null, mode: 'hidden_card', inputKind: 'self', answerText: null, verdict: null,
    grade: 'good', gradeOverridden: false, durationMs: 1000, createdAt: now, ...o,
  });

  // --- the reference: the queue as it was computed before G21 (all cards + all states, rule in JS) -------------------------------
  const legacyCards = async (tx: Tx, userId: string, boardId: string | null) => {
    if (boardId) return q.loadCards(tx, userId, boardId);
    const rows = await tx.execute<{ id: string }>(sql`select c.id from cards c join boards b on b.id = c.board_id
      where c.deleted_at is null and c.type <> 'note' and b.archived_at is null and (b.user_id = ${userId} or exists (select 1 from fsrs_state s where s.user_id = ${userId} and s.card_id = c.id))`);
    const ids = new Set(rows.map((r) => r.id));
    const viaUnion = await q.loadCards(tx, userId, null);
    expect(new Set(viaUnion.map((c) => c.id))).toEqual(ids); // the union scope is the OR-exists scope
    return viaUnion;
  };
  const legacyQueue = (userId: string, boardId: string | null, opts: { now: Date; limit?: number; filter?: QueueFilter }) =>
    db.run(userId, async (tx) => {
      const { planOf } = await import('../billing/plan');
      const [cards, states, win, plan, [pref]] = await Promise.all([
        legacyCards(tx, userId, boardId), q.loadStates(tx, userId, null), q.dayWindow(tx, userId, opts.now), planOf(userId, opts.now),
        tx.execute<{ n: number | null }>(sql`select new_cards_per_day as n from user_preferences where user_id = ${userId}`),
      ]);
      let introduced = 0;
      for (const s of states.values()) if (s.createdMs >= win.startMs) introduced++;
      const ids = boardId ? new Set(cards.map((c) => c.id)) : null;
      const scoped = ids ? new Map([...states].filter(([, s]) => ids.has(s.cardId))) : states;
      const f = opts.filter;
      const live = q.active(cards).filter((c) => (!f?.boardIds || f.boardIds.includes(c.boardId)) && (!f?.area || c.area === f.area));
      const items = q.itemsOf(live, boardId !== null);
      if (f?.ahead) return q.aheadItems(items, scoped, win.endMs).slice(0, opts.limit);
      const reasons = f ? (f.reasons ?? ['due', 'new']) : null;
      const out = q.buildQueue(items, scoped, { now: opts.now, endMs: win.endMs, newBudget: (effectiveNewCardsPerDay(pref?.n ?? null, PLAN_LIMITS[plan.plan].newCardsPerDay) ?? Infinity) - introduced });
      const kept = reasons ? out.filter((i) => reasons.includes(i.reason)) : out;
      return opts.limit === undefined ? kept : kept.slice(0, opts.limit);
    });
  const legacyDue = (userId: string, days: number) =>
    db.run(userId, async (tx) => {
      const [cards, states, win] = await Promise.all([legacyCards(tx, userId, null), q.loadStates(tx, userId, null), q.dayWindow(tx, userId, now)]);
      const out = Array<number>(days).fill(0);
      for (const it of q.itemsOf(q.active(cards), false)) {
        const m = states.get(q.stateKey(it.cardId, it.subId));
        if (!m) continue;
        const k = q.isDue(m, win.endMs) ? 0 : Math.floor((m.due.getTime() - win.endMs) / DAY) + 1;
        if (k < days) out[k]!++;
      }
      return out;
    });
  const served = async (p: Promise<{ ok: boolean; data?: QueueItem[] }>) => {
    const r = await p;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.data!;
  };

  // --- rollup references -----------------------------------------------------------------------------------------------------
  const statsNow = (userId: string, ids: string[], at = now) => db.run(userId, (tx) => st.mapStatsFor(tx, userId, ids, at));
  const scopeIds = async (userId: string) => (await db.run(userId, (tx) => st.scopeBoards(tx, userId))).map((b) => b.id).sort();
  /** Rollups must equal a rebuild from scratch, and user_daily_stats must equal the old per-day aggregate of attempts. */
  const expectConsistent = async (userId: string, at = now) => {
    const ids = await scopeIds(userId);
    const before = await statsNow(userId, ids, at);
    const rows = await dbm.db.execute<{ day: string; reviews: number; hits: number; time_ms: number }>(sql`select day::text, reviews, hits, time_ms::float8 as time_ms from user_daily_stats where user_id = ${userId} order by day`);
    const agg = await dbm.db.execute<{ day: string; reviews: number; hits: number; time_ms: number }>(sql`
      select ((a.created_at at time zone p.timezone) - interval '4 hours')::date::text as day, count(*)::int as reviews, (count(*) filter (where a.grade >= 3))::int as hits,
        coalesce(sum(a.duration_ms), 0)::float8 as time_ms
      from attempts a join profiles p on p.user_id = a.user_id where a.user_id = ${userId} group by 1 order by 1`);
    expect(rows).toEqual(agg);
    await st.rebuildUserStats(userId, at);
    expect(await scopeIds(userId)).toEqual(ids);
    expect(await statsNow(userId, ids, at)).toEqual(before);
    expect(await dbm.db.execute(sql`select day::text, reviews, hits, time_ms::float8 as time_ms from user_daily_stats where user_id = ${userId} order by day`)).toEqual(rows);
    return before;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    q = await import('./queue');
    st = await import('./stats');
    db = await import('../db');
    ra = await import('./record-attempt');
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  /** One user with every case the rule distinguishes. */
  const world = async () => {
    const u = await newUser();
    const other = await newUser();
    const a = await mkBoard(u, { updatedAt: now });
    const b = await mkBoard(u, { updatedAt: ago(3) });
    const archived = await mkBoard(u, { archived: true });
    const seed = await mkBoard(other, { status: 'seed_approved', updatedAt: ago(1) });
    const c = (board: string, o: Parameters<typeof mkCard>[1] = {}) => mkCard(board, o);
    const ids = {
      due1: await c(a, { order: 1 }), due2: await c(a, { order: 2 }), dueToday: await c(a, { order: 3 }), weak: await c(a, { order: 4 }), steady: await c(a, { order: 5 }),
      tomorrow: await c(a, { order: 6 }), flow: await c(a, { type: 'flow', order: 7, payload: steps(['s1', 's2', 's3']) }), image: await c(a, { type: 'image', order: 8, payload: masks(['m1', 'm2']) }),
      note: await c(a, { type: 'note', order: 9 }), caseCard: await c(a, { type: 'case', order: 10 }), suspended: await c(a, { order: 11, suspended: true }),
      deleted: await c(a, { order: 12, deleted: true }), tie1: await c(a, { order: 13 }), tie2: await c(a, { order: 13 }),
      archivedDue: await c(archived), seedDue: await c(seed, { order: 0 }), seedFresh: await c(seed, { order: 1 }),
      fresh: [] as string[],
    };
    for (let i = 0; i < 15; i++) ids.fresh.push(await c(b, { order: i }));
    await putState(u, ids.due1, { lastReview: ago(30), stability: 1, due: ago(29), lapses: 3 });
    await putState(u, ids.due2, { lastReview: ago(10), stability: 5, due: ago(1), lapses: 1 });
    await putState(u, ids.dueToday, { lastReview: ago(2), stability: 30, due: new Date(now.getTime() + 10 * HOUR) });
    await putState(u, ids.weak, { lastReview: ago(30), stability: 10, due: new Date(now.getTime() + 2 * DAY), lapses: 2 });
    await putState(u, ids.steady, { lastReview: new Date(now.getTime() - HOUR), stability: 50, due: new Date(now.getTime() + 9 * DAY), createdAt: new Date(now.getTime() - HOUR) });
    await putState(u, ids.tomorrow, { lastReview: ago(1), stability: 40, due: new Date(now.getTime() + 1.2 * DAY), createdAt: new Date(now.getTime() - 2 * HOUR) });
    await putState(u, ids.flow, { sub: 's1', lastReview: ago(20), stability: 2, due: ago(5) });
    await putState(u, ids.flow, { sub: 'gone', lastReview: ago(20), stability: 2, due: ago(5) }); // a removed step: never an item
    await putState(u, ids.image, { sub: 'm2', lastReview: ago(40), stability: 20, due: new Date(now.getTime() + 4 * DAY) });
    await putState(u, ids.suspended, { lastReview: ago(30), stability: 1, due: ago(29) });
    await putState(u, ids.deleted, { lastReview: ago(30), stability: 1, due: ago(29) });
    await putState(u, ids.tie1, { lastReview: ago(9), stability: 3, due: ago(2) });
    await putState(u, ids.tie2, { lastReview: ago(9), stability: 3, due: ago(2) }); // same r: card id breaks the tie
    await putState(u, ids.archivedDue, { lastReview: ago(30), stability: 1, due: ago(29) });
    await putState(u, ids.seedDue, { lastReview: ago(30), stability: 2, due: ago(10) });
    return { u, a, b, seed, ids };
  };

  describe('queue: same items, same order as the reference', () => {
    it('daily, filtered, ahead and board queues for several limits', async () => {
      const w = await world();
      const filters: (QueueFilter | undefined)[] = [
        undefined, { reasons: ['due', 'new', 'weak'] }, { reasons: ['weak'] }, { reasons: ['new'] }, { boardIds: [w.b] }, { boardIds: [w.a, w.seed], reasons: ['due', 'weak'] },
        { area: 'CM' }, { ahead: true }, { ahead: true, boardIds: [w.a] },
      ];
      for (const limit of [undefined, 1, 2, 5, 12, 100])
        for (const filter of filters) {
          const got = await served(filter ? q.getFilteredQueue(w.u, filter, { now, limit }) : q.getDailyQueue(w.u, { now, limit }));
          expect(got, JSON.stringify({ limit, filter })).toEqual(await legacyQueue(w.u, null, { now, limit, filter }));
        }
      for (const board of [w.a, w.b, w.seed])
        for (const limit of [undefined, 3]) expect(await served(q.getBoardQueue(w.u, board, { now, limit }))).toEqual(await legacyQueue(w.u, board, { now, limit }));
      const daily = await served(q.getDailyQueue(w.u, { now }));
      expect(daily[0]).toMatchObject({ cardId: w.ids.due1, reason: 'due' }); // lowest recall first
      expect(daily.some((i) => [w.ids.note, w.ids.suspended, w.ids.deleted, w.ids.archivedDue, w.ids.seedFresh].includes(i.cardId))).toBe(false);
      expect(daily.filter((i) => i.cardId === w.ids.flow).map((i) => i.subId)).toEqual(['s1', 's2', 's3']); // s1 due, s2/s3 new; the state of the removed step 'gone' is never an item
    });

    it('the new-card cap (plan, preference, introduced today) and the clock', async () => {
      const w = await world();
      await dbm.db.execute(sql`insert into user_preferences (user_id, new_cards_per_day) values (${w.u}, 5) on conflict (user_id) do update set new_cards_per_day = 5`);
      for (const at of [now, new Date(now.getTime() + 17 * HOUR), new Date(now.getTime() + 3 * DAY)])
        expect(await served(q.getDailyQueue(w.u, { now: at }))).toEqual(await legacyQueue(w.u, null, { now: at }));
    });

    it('dueByOffset (Hoje, hub forecast) equals the reference buckets', async () => {
      const w = await world();
      for (const days of [1, 7, 14]) expect(await db.run(w.u, async (tx) => q.dueByOffset(tx, w.u, await q.dayWindow(tx, w.u, now), days))).toEqual(await legacyDue(w.u, days));
    });
  });

  describe('rollups after each write', () => {
    it('answer (recordAttempt), suspend, reset', async () => {
      const w = await world();
      const first = await expectConsistent(w.u);
      expect(first.get(w.a)).toMatchObject({ cards: 12, notes: 1, due: 6 }); // 14 cards on a minus the note and the deleted one; due: due1, due2, dueToday, tie1, tie2, flow s1
      expect(first.get(w.seed)).toMatchObject({ cards: 1 }); // another user's board: only the card with state
      for (const card of [w.ids.due1, w.ids.fresh[0]!, w.ids.seedFresh]) {
        expect((await ra.recordAttempt(attempt(w.u, card, { grade: 'again', durationMs: 3000 }))).ok).toBe(true);
        await expectConsistent(w.u);
      }
      const { setCardStudy } = await import('./study');
      await setCardStudy(w.u, w.ids.due2, 'suspend');
      expect((await expectConsistent(w.u)).get(w.a)!.due).toBe(first.get(w.a)!.due - 1); // due1 answered 'again' (due again in minutes), due2 suspended
      await setCardStudy(w.u, w.ids.flow, 'reset');
      await expectConsistent(w.u);
    });

    it('map edits: create/delete card, edges, move (no invalidation), card payload, duplicate, delete board', async () => {
      const w = await world();
      await expectConsistent(w.u);
      const boards = await import('../boards/boards');
      const id = uuid();
      const op = { opId: uuid(), boardId: w.a };
      expect((await boards.applyMapOps(w.u, [{ ...op, op: 'createCard', card: { id, type: 'concept', title: 'n', position: { x: 1, y: 1 } } }])).ok).toBe(true);
      expect((await expectConsistent(w.u)).get(w.a)!.cards).toBe(13);
      await boards.applyMapOps(w.u, [{ ...op, opId: uuid(), op: 'createEdge', edge: { id: uuid(), fromCardId: id, toCardId: w.ids.due1, label: null } }]);
      expect((await expectConsistent(w.u)).get(w.a)!.edges).toBe(1);
      const [{ v: v0 } = { v: -1 }] = await dbm.db.execute<{ v: number }>(sql`select version as v from map_stats where user_id = ${w.u} and board_id = ${w.a}`);
      await boards.applyMapOps(w.u, [{ ...op, opId: uuid(), op: 'moveCards', moves: [{ cardId: id, position: { x: 50, y: 60 } }] }]);
      const [{ v: v1 } = { v: -2 }] = await dbm.db.execute<{ v: number }>(sql`select version as v from map_stats where user_id = ${w.u} and board_id = ${w.a}`);
      expect(v1).toBe(v0); // autosave of positions does not touch the stats
      await boards.applyMapOps(w.u, [{ ...op, opId: uuid(), op: 'deleteCards', cardIds: [id] }]);
      expect((await expectConsistent(w.u)).get(w.a)).toMatchObject({ cards: 12, edges: 0 });
      await dbm.db.update(dbm.cards).set({ payload: steps(['s1']) }).where(eq(dbm.cards.id, w.ids.flow)); // steps removed by an edit
      await expectConsistent(w.u);
      await dbm.db.update(dbm.boards).set({ archivedAt: now }).where(eq(dbm.boards.id, w.b)); // Free: 2 active maps; archiving leaves the scope
      await expectConsistent(w.u);
      const dup = await boards.duplicateBoard(w.u, w.a, 'Cópia');
      expect(dup.ok, JSON.stringify(dup)).toBe(true);
      await expectConsistent(w.u);
      expect((await ra.recordAttempt(attempt(w.u, w.ids.due1, { createdAt: ago(1) }))).ok).toBe(true);
      expect((await boards.deleteBoard(w.u, w.a)).ok).toBe(true); // cascades cards -> states, attempts -> user_daily_stats
      const after = await expectConsistent(w.u);
      expect(after.has(w.a)).toBe(false);
    });

    it('cascades and clock: hard-deleted card, timezone change, a later now', async () => {
      const w = await world();
      for (const [card, d] of [[w.ids.due1, 0], [w.ids.due2, 1], [w.ids.weak, 2]] as const) await ra.recordAttempt(attempt(w.u, card, { createdAt: new Date(now.getTime() - d * DAY - 9 * HOUR) }));
      await expectConsistent(w.u);
      await dbm.db.execute(sql`delete from cards where id = ${w.ids.due2}`); // what purgeDeletedCards does after 30 days
      await expectConsistent(w.u);
      await dbm.db.update(dbm.profiles).set({ timezone: 'Asia/Tokyo' }).where(eq(dbm.profiles.userId, w.u)); // re-buckets the days
      await expectConsistent(w.u);
      await dbm.db.update(dbm.profiles).set({ timezone: 'America/Sao_Paulo' }).where(eq(dbm.profiles.userId, w.u));
      await expectConsistent(w.u, new Date(now.getTime() + 5 * HOUR)); // stale_at passed inside the same day
      await expectConsistent(w.u, new Date(now.getTime() + 2 * DAY)); // another study day
    });

    it('a recompute that read before a concurrent write loses the upsert (version guard)', async () => {
      const w = await world();
      await statsNow(w.u, [w.a]);
      await dbm.db.execute(sql`update map_stats set version = version + 1, stale_at = null where user_id = ${w.u} and board_id = ${w.a}`);
      const [{ v } = { v: 0 }] = await dbm.db.execute<{ v: number }>(sql`select version as v from map_stats where user_id = ${w.u} and board_id = ${w.a}`);
      // a reader that saw the previous version: its upsert (same SQL as mapStatsFor) must not clear the stale mark
      await db.run(w.u, (tx) => tx.execute(sql`insert into map_stats as m (user_id, board_id, cards, version, day_end, stale_at) values (${w.u}, ${w.a}, 999, ${v - 1}, now(), now() + interval '1 day')
        on conflict (user_id, board_id) do update set cards = excluded.cards, stale_at = excluded.stale_at where m.version = excluded.version`));
      const [row] = await dbm.db.execute<{ cards: number; stale: boolean }>(sql`select cards, stale_at is null as stale from map_stats where user_id = ${w.u} and board_id = ${w.a}`);
      expect(row).toMatchObject({ stale: true });
      expect(row!.cards).not.toBe(999);
    });

    it('RLS: a user reads and writes only their own rollup rows', async () => {
      const w = await world();
      const intruder = await newUser();
      await expectConsistent(w.u);
      const seen = await db.run(intruder, (tx) => tx.execute(sql`select 1 from map_stats where user_id = ${w.u} union all select 1 from user_daily_stats where user_id = ${w.u}`));
      expect(seen).toHaveLength(0);
      await expect(db.run(intruder, (tx) => tx.execute(sql`insert into user_daily_stats (user_id, day, reviews) values (${intruder}, '2026-01-01', 5)`))).rejects.toThrow();
      await expect(db.run(intruder, (tx) => tx.execute(sql`insert into map_stats (user_id, board_id) values (${w.u}, ${w.a})`))).rejects.toThrow();
    });
  });
});
