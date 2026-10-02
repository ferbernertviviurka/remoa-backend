// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attempt, QueueItem, RetrievabilityMap } from '@remoa/contracts';

config({ path: '../../.env' });

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe.skipIf(!process.env.DATABASE_URL)('/v1/review', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let q: typeof import('../review/queue');
  let ra: typeof import('../review/record-attempt');

  const newUser = async (tz?: string) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (tz) await dbm.db.update(dbm.profiles).set({ timezone: tz }).where(eq(dbm.profiles.userId, id));
    return id;
  };
  const call = async (user: string, path: string) => {
    const res = await app.request(`/v1${path}`, { headers: { authorization: `Bearer ${user}` } });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const mkBoard = async (userId: string, updatedAt = new Date()) => {
    const [b] = await dbm.db.insert(dbm.boards).values({ userId, title: 'Mapa', updatedAt }).returning();
    return b!.id;
  };
  const mkCard = async (boardId: string, o: { type?: 'concept' | 'flow' | 'image' | 'case' | 'note'; order?: number; payload?: unknown } = {}) => {
    const [c] = await dbm.db.insert(dbm.cards).values({ boardId, type: o.type ?? 'concept', title: 'c', order: o.order ?? 0, payload: o.payload ?? {} }).returning();
    return c!.id;
  };
  const mkFlow = (boardId: string, n = 6) => {
    const steps = Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, text: `passo ${i + 1}` }));
    return mkCard(boardId, { type: 'flow', payload: { steps } });
  };
  type St = { sub?: string; lastReview: Date; stability: number; due: Date; createdAt?: Date };
  const stateRow = (userId: string, cardId: string, s: St) => ({
    userId, cardId, subId: s.sub ?? '', stability: s.stability, difficulty: 5, due: s.due, reps: 3, lapses: 0, lastReview: s.lastReview,
    state: 'review' as const, scheduledDays: 5, createdAt: s.createdAt ?? s.lastReview,
  });
  const putState = (userId: string, cardId: string, s: St) => dbm.db.insert(dbm.fsrsState).values(stateRow(userId, cardId, s));
  const attempt = (userId: string, cardId: string, o: Partial<Attempt> = {}): Attempt => ({
    id: uuid(), userId, cardId, subId: null, sessionId: null, mode: 'hidden_card', inputKind: 'self', answerText: null, verdict: null,
    grade: 'good', gradeOverridden: false, durationMs: 1000, createdAt: new Date('2026-06-10T15:00:00Z'), ...o,
  });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    q = await import('../review/queue');
    ra = await import('../review/record-attempt');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  describe('recordAttempt', () => {
    it('is idempotent by attempt id: one attempt row, one schedule', async () => {
      const u = await newUser();
      const card = await mkCard(await mkBoard(u));
      const a = attempt(u, card);
      const first = await ra.recordAttempt(a);
      const second = await ra.recordAttempt(a);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.state.reps).toBe(1);
      expect(second.data.due).toEqual(first.data.due);
      expect(first.data.state).toMatchObject({ cardId: card, subId: null, state: 'learning', lastReview: a.createdAt });
      const rows = await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, u));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ grade: 3, subId: '', gradeOverridden: false });
      const [st] = await dbm.db.select().from(dbm.fsrsState).where(eq(dbm.fsrsState.userId, u));
      expect(st!.reps).toBe(1);
    });

    it('concurrent duplicates of one attempt id are also a single attempt', async () => {
      const u = await newUser();
      const card = await mkCard(await mkBoard(u));
      const a = attempt(u, card);
      const rs = await Promise.all([ra.recordAttempt(a), ra.recordAttempt(a), ra.recordAttempt(a)]);
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, u))).toHaveLength(1);
      expect((await dbm.db.select().from(dbm.fsrsState).where(eq(dbm.fsrsState.userId, u)))[0]!.reps).toBe(1);
    });

    it('5 concurrent attempts on the same item: reps = 5, no lost update', async () => {
      const u = await newUser();
      const card = await mkCard(await mkBoard(u));
      const t0 = new Date('2026-06-10T15:00:00Z').getTime();
      const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => ra.recordAttempt(attempt(u, card, { createdAt: new Date(t0 + i * 1000) }))));
      expect(rs.every((r) => r.ok)).toBe(true);
      const [st] = await dbm.db.select().from(dbm.fsrsState).where(eq(dbm.fsrsState.userId, u));
      expect(st!.reps).toBe(5);
      expect(await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, u))).toHaveLength(5);
    });

    it('unreadable, missing or deleted card -> not_found; bad subId -> validation', async () => {
      const a = await newUser();
      const b = await newUser();
      const board = await mkBoard(a);
      const card = await mkCard(board);
      const flow = await mkFlow(board);
      const gone = await mkCard(board);
      await dbm.db.update(dbm.cards).set({ deletedAt: new Date() }).where(eq(dbm.cards.id, gone));

      const foreign = await ra.recordAttempt(attempt(b, card));
      expect(foreign).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await ra.recordAttempt(attempt(a, uuid()))).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await ra.recordAttempt(attempt(a, gone))).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await ra.recordAttempt(attempt(a, card, { subId: 'x' }))).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(await ra.recordAttempt(attempt(a, flow))).toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(await ra.recordAttempt(attempt(a, flow, { subId: 'nope' }))).toMatchObject({ ok: false, error: { code: 'validation' } });
      const okStep = await ra.recordAttempt(attempt(a, flow, { subId: 's2', mode: 'next_step' }));
      expect(okStep).toMatchObject({ ok: true, data: { state: { subId: 's2', reps: 1 } } });
      // validation failures leave no state behind
      expect(await dbm.db.select().from(dbm.fsrsState).where(eq(dbm.fsrsState.userId, a))).toHaveLength(1);
      expect(await dbm.db.select().from(dbm.fsrsState).where(eq(dbm.fsrsState.userId, b))).toHaveLength(0);
    });

    it('seed boards (readable, not owned) accept attempts', async () => {
      const a = await newUser();
      const b = await newUser();
      const [seed] = await dbm.db.insert(dbm.boards).values({ userId: a, title: 'Seed', status: 'seed_approved' }).returning();
      const card = await mkCard(seed!.id);
      expect((await ra.recordAttempt(attempt(b, card))).ok).toBe(true);
    });
  });

  describe('queue', () => {
    const now = new Date('2026-06-10T15:00:00Z'); // 12:00 in America/Sao_Paulo; study day = 06-10 07:00Z .. 06-11 07:00Z
    const ago = (days: number) => new Date(now.getTime() - days * DAY);

    it('orders due by r asc, then new (free cap 10, minus introduced today), then weak', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const d1 = await mkCard(board, { order: 100 });
      const d2 = await mkCard(board, { order: 101 });
      const w = await mkCard(board, { order: 102 });
      const t1 = await mkCard(board, { order: 103 });
      const t2 = await mkCard(board, { order: 104 });
      const fresh: string[] = [];
      for (let i = 0; i < 25; i++) fresh.push(await mkCard(board, { order: i }));
      await putState(u, d1, { lastReview: ago(30), stability: 1, due: ago(29) }); // r ~ .59
      await putState(u, d2, { lastReview: ago(10), stability: 5, due: ago(1) }); // r ~ .85
      await putState(u, w, { lastReview: ago(30), stability: 10, due: new Date(now.getTime() + 2 * DAY) }); // r ~ .81, not due
      for (const t of [t1, t2]) await putState(u, t, { lastReview: new Date(now.getTime() - HOUR), stability: 50, due: new Date(now.getTime() + 3 * DAY) }); // introduced today

      const r = await q.getDailyQueue(u, { now });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.map((i) => i.reason)).toEqual(['due', 'due', ...Array(8).fill('new'), 'weak']);
      expect(r.data.map((i) => i.cardId)).toEqual([d1, d2, ...fresh.slice(0, 8), w]);
      expect(r.data[0]).toEqual({ cardId: d1, boardId: board, subId: null, reason: 'due', mode: 'hidden_card' });

      const limited = await q.getDailyQueue(u, { now, limit: 3 });
      expect(limited.ok && limited.data.map((i) => i.cardId)).toEqual([d1, d2, fresh[0]]);
      // deterministic
      expect(await q.getDailyQueue(u, { now })).toEqual(r);
    });

    it('study day rolls over at 04:00 local', async () => {
      const u = await newUser('America/Sao_Paulo');
      const board = await mkBoard(u);
      const early = await mkCard(board, { order: 0 });
      const late = await mkCard(board, { order: 1 });
      const recent = { lastReview: new Date(now.getTime() - HOUR), stability: 400 };
      await putState(u, early, { ...recent, due: new Date('2026-06-11T06:59:00Z') }); // 03:59 local tomorrow: today
      await putState(u, late, { ...recent, due: new Date('2026-06-11T07:01:00Z') }); // 04:01 local tomorrow: tomorrow
      const r = await q.getDailyQueue(u, { now });
      expect(r.ok && r.data.map((i) => [i.cardId, i.reason])).toEqual([[early, 'due']]);
      // another timezone moves the boundary: Tokyo's day ends 04:00 JST = 06-10 19:00Z
      const tokyo = await newUser('Asia/Tokyo');
      const tb = await mkBoard(tokyo);
      const c = await mkCard(tb);
      await putState(tokyo, c, { ...recent, due: new Date('2026-06-10T19:30:00Z') });
      const t = await q.getDailyQueue(tokyo, { now });
      expect(t.ok && t.data).toEqual([]);
    });

    it('flow and image cards queue one item per step / mask; empty ones have none', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const flow = await mkCard(board, { type: 'flow', order: 0, payload: { steps: ['s1', 's2', 's3'].map((id) => ({ id, text: id })) } });
      const m1 = uuid();
      const m2 = uuid();
      const image = await mkCard(board, { type: 'image', order: 1, payload: { assetId: uuid(), masks: [{ id: m1 }, { id: m2 }] } });
      await mkCard(board, { type: 'image', payload: { assetId: uuid(), masks: [] } });
      await mkCard(board, { type: 'flow', payload: {} });
      const caseCard = await mkCard(board, { type: 'case', order: 2 });
      await putState(u, flow, { sub: 's2', lastReview: ago(30), stability: 1, due: ago(20) });
      const r = await q.getDailyQueue(u, { now });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const key = (i: QueueItem) => `${i.reason}:${i.mode}:${i.cardId}:${i.subId ?? ''}`;
      expect(r.data.map(key)).toEqual([
        `due:next_step:${flow}:s2`, `new:next_step:${flow}:s1`, `new:next_step:${flow}:s3`,
        ...[m1, m2].map((m) => `new:occlusion:${image}:${m}`), `new:case:${caseCard}:`,
      ]);
    });

    it('board queue stays inside its board and 404s for boards the user cannot read', async () => {
      const a = await newUser();
      const b = await newUser();
      const b1 = await mkBoard(a);
      const b2 = await mkBoard(a);
      const c1 = await mkCard(b1);
      const c2 = await mkCard(b2);
      await putState(a, c2, { lastReview: ago(30), stability: 1, due: ago(20) });
      const r1 = await q.getBoardQueue(a, b1, { now });
      expect(r1.ok && r1.data.map((i) => [i.cardId, i.reason])).toEqual([[c1, 'new']]);
      const r2 = await q.getBoardQueue(a, b2, { now });
      expect(r2.ok && r2.data.map((i) => [i.cardId, i.reason])).toEqual([[c2, 'due']]);

      expect(await q.getBoardQueue(b, b1, { now })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect((await call(b, `/review/queue?boardId=${b1}`)).status).toBe(404);
      expect((await call(b, `/review/retrievability?boardId=${b1}`)).status).toBe(404);
      expect((await call(b, '/review/queue')).json.data).toEqual([]);
      expect((await call(a, `/review/queue?boardId=${b1}`)).json.data).toHaveLength(1);
    });

    it('seed board: board queue works for any reader, daily queue only after they have state', async () => {
      const a = await newUser();
      const b = await newUser();
      const [seed] = await dbm.db.insert(dbm.boards).values({ userId: a, title: 'Seed', status: 'seed_approved' }).returning();
      const c1 = await mkCard(seed!.id, { order: 0 });
      const c2 = await mkCard(seed!.id, { order: 1 });
      const board = await q.getBoardQueue(b, seed!.id, { now });
      expect(board.ok && board.data.map((i) => i.cardId)).toEqual([c1, c2]);
      expect((await q.getDailyQueue(b, { now })).ok && (await q.getDailyQueue(b, { now }))).toMatchObject({ data: [] });
      await putState(b, c1, { lastReview: ago(30), stability: 1, due: ago(20) });
      const daily = await q.getDailyQueue(b, { now });
      expect(daily.ok && daily.data.map((i) => [i.cardId, i.reason])).toEqual([[c1, 'due']]);
    });

    it('validates query params', async () => {
      const u = await newUser();
      expect((await call(u, '/review/queue?limit=0')).status).toBe(422);
      expect((await call(u, '/review/queue?boardId=nope')).status).toBe(422);
      expect((await call(u, '/review/retrievability')).status).toBe(422);
      expect((await call(u, '/review/queue')).status).toBe(200);
      const res = await app.request('/v1/review/queue');
      expect(res.status).toBe(401);
    });
  });

  describe('retrievability', () => {
    it('flow with a weak step 5 -> card watch, sub review; unreviewed -> unknown; cache is dropped by recordAttempt', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const flow = await mkFlow(board, 6);
      const concept = await mkCard(board);
      const untouched = await mkCard(board);
      const real = new Date();
      const recent = new Date(real.getTime() - DAY);
      for (const i of [1, 2, 3, 4, 6]) await putState(u, flow, { sub: `s${i}`, lastReview: recent, stability: 60, due: new Date(real.getTime() + 50 * DAY) });
      await putState(u, flow, { sub: 's5', lastReview: new Date(real.getTime() - 30 * DAY), stability: 1, due: new Date(real.getTime() - 20 * DAY) });
      await putState(u, concept, { lastReview: recent, stability: 60, due: new Date(real.getTime() + 50 * DAY) });

      const res = await call(u, `/review/retrievability?boardId=${board}`);
      expect(res.status).toBe(200);
      const map = res.json.data as RetrievabilityMap;
      expect(map[flow]).toMatchObject({ state: 'watch' });
      expect(map[flow]!.subs!.s5!.state).toBe('review');
      expect(map[flow]!.subs!.s1!.state).toBe('steady');
      expect(Object.keys(map[flow]!.subs!)).toHaveLength(6);
      expect(new Date(map[flow]!.due!).getTime()).toBeLessThan(real.getTime()); // earliest due = step 5
      expect(map[concept]).toMatchObject({ state: 'steady' });
      expect(map[untouched]).toEqual({ r: 0, state: 'unknown', due: null });

      // cached: a direct state change is not visible, but recordAttempt invalidates
      await dbm.db.delete(dbm.fsrsState).where(eq(dbm.fsrsState.cardId, concept));
      expect(((await call(u, `/review/retrievability?boardId=${board}`)).json.data as RetrievabilityMap)[concept]!.state).toBe('steady');
      expect((await ra.recordAttempt(attempt(u, untouched, { createdAt: new Date() }))).ok).toBe(true);
      const after = (await call(u, `/review/retrievability?boardId=${board}`)).json.data as RetrievabilityMap;
      expect(after[concept]!.state).toBe('unknown');
      expect(after[untouched]!.state).not.toBe('unknown');
    });

    it('500 cards (with flows) + states in < 100 ms warm, no cache', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const real = new Date();
      const ids: { id: string; type: string }[] = [];
      const cardRows = Array.from({ length: 500 }, (_, i) => {
        const flow = i % 50 === 0;
        return {
          id: uuid(), boardId: board, type: flow ? ('flow' as const) : ('concept' as const), title: `c${i}`, order: i,
          payload: flow ? { steps: Array.from({ length: 8 }, (_, k) => ({ id: `s${k}`, text: 't' })) } : {},
        };
      });
      await dbm.db.insert(dbm.cards).values(cardRows);
      for (const c of cardRows) ids.push({ id: c.id, type: c.type });
      const states = ids.flatMap(({ id, type }, i) =>
        (type === 'flow' ? Array.from({ length: 8 }, (_, k) => `s${k}`) : ['']).map((sub) =>
          stateRow(u, id, { sub, lastReview: new Date(real.getTime() - (i % 30) * DAY), stability: 5 + (i % 7), due: new Date(real.getTime() + (i % 9 - 3) * DAY) }),
        ),
      );
      await dbm.db.insert(dbm.fsrsState).values(states);
      await q.computeRetrievability(u, board, real); // warm
      const times: number[] = [];
      let size = 0;
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        const r = await q.computeRetrievability(u, board, real);
        times.push(performance.now() - t);
        if (r.ok) size = Object.keys(r.data).length;
      }
      expect(size).toBe(500);
      // median, not max: test files share one local Postgres and run in parallel, so a single slow sample is contention, not the code
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      expect(median(times)).toBeLessThan(100); // caught a real 200 ms plan regression (D-066), keep it in the default suite

      // QA: the daily queue and the boards badge run the same loaders over ~600 states; target <= 200 ms server time
      const timeIt = async (path: string) => {
        await call(u, path); // warm
        const ms: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          const res = await call(u, path);
          ms.push(performance.now() - t0);
          expect(res.status).toBe(200);
        }
        return median(ms);
      };
      expect(await timeIt('/review/queue?limit=500')).toBeLessThan(200);
      expect(await timeIt('/boards')).toBeLessThan(200);
    });
  });

  describe('board list extras (G01)', () => {
    type Summary = { id: string; stateCounts: Record<string, number>; preview: { nodes: { x: number; y: number; state: string }[]; edges: [number, number][] } };
    const listed = async (u: string, board: string) => ((await call(u, '/boards')).json.data as Summary[]).find((b) => b.id === board)!;

    it('state counts are card-level; preview is normalised (aspect kept), edges remapped', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const real = new Date();
      const recent = new Date(real.getTime() - DAY);
      const far = new Date(real.getTime() + 50 * DAY);
      const flow = await mkFlow(board, 6);
      const steady = await mkCard(board);
      const unseen = await mkCard(board);
      for (const i of [1, 2, 3, 4, 6]) await putState(u, flow, { sub: `s${i}`, lastReview: recent, stability: 60, due: far });
      await putState(u, flow, { sub: 's5', lastReview: new Date(real.getTime() - 30 * DAY), stability: 1, due: new Date(real.getTime() - 20 * DAY) });
      await putState(u, steady, { lastReview: recent, stability: 60, due: far });
      const pos: [string, number, number, number][] = [[flow, 100, 300, 0], [steady, 500, 100, 1], [unseen, 300, 200, 2]];
      for (const [id, x, y, order] of pos) await dbm.db.update(dbm.cards).set({ x, y, order }).where(eq(dbm.cards.id, id));
      await dbm.db.insert(dbm.edges).values([{ boardId: board, fromCardId: flow, toCardId: unseen }, { boardId: board, fromCardId: unseen, toCardId: steady }]);

      const b = await listed(u, board);
      expect(b.stateCounts).toEqual({ review: 0, watch: 1, steady: 1, unknown: 1 });
      // box 100..500 x 100..300, span 400 (x and y share it)
      expect(b.preview.nodes).toEqual([{ x: 0, y: 0.5, state: 'watch' }, { x: 1, y: 0, state: 'steady' }, { x: 0.5, y: 0.25, state: 'unknown' }]);
      expect(b.preview.edges).toEqual(expect.arrayContaining([[0, 2], [2, 1]]));
      expect(b.preview.edges).toHaveLength(2);
    });

    it('caps the preview at 60 nodes, drops edges to the rest; empty board is zeros', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const rows = Array.from({ length: 70 }, (_, i) => ({ id: uuid(), boardId: board, title: `c${i}`, order: i, x: i * 10, y: (i % 5) * 10 }));
      await dbm.db.insert(dbm.cards).values(rows);
      await dbm.db.insert(dbm.edges).values([
        { boardId: board, fromCardId: rows[0]!.id, toCardId: rows[1]!.id },
        { boardId: board, fromCardId: rows[0]!.id, toCardId: rows[65]!.id },
      ]);
      const b = await listed(u, board);
      expect(b.preview.nodes).toHaveLength(60);
      expect(b.preview.edges).toEqual([[0, 1]]);
      expect(b.stateCounts).toEqual({ review: 0, watch: 0, steady: 0, unknown: 70 });
      for (const n of b.preview.nodes) expect(n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1).toBe(true);

      const empty = await listed(u, await mkBoard(u));
      expect(empty.stateCounts).toEqual({ review: 0, watch: 0, steady: 0, unknown: 0 });
      expect(empty.preview).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('dueCount (FR-8)', () => {
    it('badge equals the due items of the board queue', async () => {
      const u = await newUser();
      const b1 = await mkBoard(u);
      const b2 = await mkBoard(u);
      const real = Date.now();
      const stale = { lastReview: new Date(real - 30 * DAY), stability: 1, due: new Date(real - 20 * DAY) };
      const c1 = await mkCard(b1);
      const c2 = await mkCard(b1);
      await mkCard(b1);
      const flow = await mkFlow(b1, 4);
      await mkFlow(b2, 2);
      const gone = await mkCard(b1);
      await putState(u, c1, stale);
      await putState(u, c2, { ...stale, due: new Date(real + 20 * DAY), lastReview: new Date(real - DAY), stability: 80 });
      await putState(u, flow, { ...stale, sub: 's1' });
      await putState(u, flow, { ...stale, sub: 's3' });
      await putState(u, flow, { ...stale, sub: 'removed-step' }); // stale sub: ignored by both
      await putState(u, gone, stale);
      await dbm.db.update(dbm.cards).set({ deletedAt: new Date() }).where(eq(dbm.cards.id, gone));

      const list = (await call(u, '/boards')).json.data as { id: string; dueCount: number }[];
      for (const b of [b1, b2]) {
        const queue = (await call(u, `/review/queue?boardId=${b}`)).json.data as QueueItem[];
        expect(list.find((x) => x.id === b)!.dueCount).toBe(queue.filter((i) => i.reason === 'due').length);
      }
      expect(list.find((x) => x.id === b1)!.dueCount).toBe(3);
      expect(list.find((x) => x.id === b2)!.dueCount).toBe(0);
    });
  });
  describe('D-200 note cards', () => {
    it('never queued, counted, mapped or attemptable; the other cards are unaffected', async () => {
      const u = await newUser();
      const board = await mkBoard(u);
      const note = await mkCard(board, { type: 'note' });
      const concept = await mkCard(board);
      await putState(u, note, { lastReview: new Date(Date.now() - 30 * DAY), stability: 1, due: new Date(Date.now() - 20 * DAY) }); // crafted: even with a due state
      await putState(u, concept, { lastReview: new Date(Date.now() - 30 * DAY), stability: 1, due: new Date(Date.now() - 20 * DAY) });
      for (const path of ['/review/queue', `/review/queue?boardId=${board}`]) {
        expect(((await call(u, path)).json.data as QueueItem[]).map((i) => i.cardId)).toEqual([concept]);
      }
      expect(Object.keys((await call(u, `/review/retrievability?boardId=${board}`)).json.data)).toEqual([concept]);
      const listed = ((await call(u, '/boards')).json.data as { id: string; dueCount: number; stateCounts: Record<string, number>; preview: { nodes: unknown[] } }[]).find((b) => b.id === board)!;
      expect([listed.dueCount, Object.values(listed.stateCounts).reduce((a, b) => a + b, 0), listed.preview.nodes.length]).toEqual([1, 1, 1]);
      const r = await ra.recordAttempt(attempt(u, note));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('validation');
    });
  });
});
