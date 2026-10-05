// G15: Integration (needs local Supabase, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewHubSchema, startSessionInputSchema, type Attempt } from '@remoa/contracts';

config({ path: '../../.env' });

const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('/v1/review/hub', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let hubm: typeof import('../review/hub');
  let q: typeof import('../review/queue');
  let ra: typeof import('../review/record-attempt');
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY);

  const newUser = async (pro = false) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (pro) await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan: 'pro', status: 'active' });
    return id;
  };
  const mkBoard = async (userId: string, title = 'Mapa', area: 'CM' | 'PED' = 'CM') => (await dbm.db.insert(dbm.boards).values({ userId, title, area }).returning())[0]!.id;
  const mkCards = async (boardId: string, n: number, from = 0) => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: uuid(), boardId, type: 'concept' as const, title: `card ${from + i}`, order: from + i }));
    await dbm.db.insert(dbm.cards).values(rows);
    return rows.map((r) => r.id);
  };
  const putState = (userId: string, cardId: string, o: { last: Date; stability: number; due: Date; lapses?: number }) =>
    dbm.db.insert(dbm.fsrsState).values({ userId, cardId, stability: o.stability, difficulty: 5, due: o.due, reps: 3, lapses: o.lapses ?? 0, lastReview: o.last, state: 'review', scheduledDays: 5, createdAt: o.last });
  const putAttempt = (userId: string, cardId: string, at: Date, grade = 3) =>
    dbm.db.insert(dbm.attempts).values({ userId, cardId, mode: 'hidden_card', inputKind: 'self', grade, durationMs: 20_000, createdAt: at });
  const attempt = (userId: string, cardId: string): Attempt => ({
    id: uuid(), userId, cardId, subId: null, sessionId: null, mode: 'hidden_card', inputKind: 'self', answerText: null, verdict: null,
    grade: 'good', gradeOverridden: false, durationMs: 1000, createdAt: new Date(),
  });
  const hub = async (u: string) => {
    const r = await hubm.getReviewHub(u, now);
    if (!r.ok) throw new Error('hub failed');
    return reviewHubSchema.parse(r.data);
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    hubm = await import('../review/hub');
    q = await import('../review/queue');
    ra = await import('../review/record-attempt');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  /** 2 due (one lapsed 4x), 1 weak (not due, r < .9), 1 steady, 25 new; 3 attempts today, one yesterday. */
  const seed = async (u: string) => {
    const board = await mkBoard(u, 'Sepse');
    const [d1, d2, w, s] = await mkCards(board, 4);
    const fresh = await mkCards(board, 25, 10);
    await putState(u, d1!, { last: ago(30), stability: 1, due: ago(29), lapses: 4 });
    await putState(u, d2!, { last: ago(10), stability: 5, due: ago(1) });
    await putState(u, w!, { last: ago(30), stability: 10, due: new Date(now.getTime() + 2 * DAY) });
    await putState(u, s!, { last: ago(1), stability: 200, due: new Date(now.getTime() + 60 * DAY) });
    for (const [c, at, g] of [[d1!, ago(0), 1], [d2!, ago(0), 3], [s!, ago(0), 4], [s!, ago(1), 3]] as const) await putAttempt(u, c, new Date(at.getTime() - 60_000), g);
    return { board, d1: d1!, d2: d2!, w: w!, s: s!, fresh };
  };

  it('Free: shape, queue composition (due + new up to 10, weak optional), indicators', async () => {
    const u = await newUser();
    const x = await seed(u);
    const h = await hub(u);
    expect(h.status).toBe('active');
    expect(h.queue.counts).toEqual({ due: 2, new: 10, weak: 1 });
    expect(h.queue.defaultCount).toBe(12);
    expect(h.queue.newLimit).toBe(10);
    expect(h.queue.items.filter((i) => i.reason === 'new')).toHaveLength(10);
    expect(h.queue.items.map((i) => i.reason).slice(0, 3)).toEqual(['due', 'due', 'new']);
    expect(h.queue.items[0]!.cardId).toBe(x.d1); // lowest recall first
    expect(h.queue.secondsPerCard).toBe(20); // median of the user's 20 s attempts
    expect(h.queue.estimatedSeconds).toBe(240);
    expect(h.states.review + h.states.watch + h.states.steady + h.states.unknown).toBe(29);
    expect(h.kpis.firmTotal).toBe(29);
    expect(h.kpis.reviews7).toBe(4);
    expect(h.kpis.streak).toBeGreaterThanOrEqual(1);
    expect(h.kpis.retention30).toBeCloseTo(0.75);
    expect(h.forecast[0]!.count).toBe(2);
    expect(h.hardCards.map((c) => [c.cardId, c.lapses, c.boardTitle])).toEqual([[x.d1, 4, 'Sepse']]);
    expect(h.maps).toHaveLength(1);
    expect(h.maps[0]).toMatchObject({ title: 'Sepse', cards: 29, due: 2, new: 10, weak: 1 });
    expect(h.areas.find((a) => a.area === 'CM')).toMatchObject({ cards: 29, dueToday: 2, attempts: 4 });
    expect(h.activity.find((a) => a.date === h.today.day)).toMatchObject({ count: 3, future: false });
    // same source as the daily queue (rail badge / Hoje)
    const daily = await q.getDailyQueue(u, { now });
    expect(daily.ok && daily.data.filter((i) => i.reason !== 'weak').length).toBe(h.queue.defaultCount);
  });

  it('Pro: unlimited new per day (D-647, newLimit/newRemaining null)', async () => {
    const u = await newUser(true);
    const board = await mkBoard(u);
    await mkCards(board, 30);
    const h = await hub(u);
    expect(h.queue).toMatchObject({ newLimit: null, newRemaining: null, counts: { due: 0, new: 30, weak: 0 }, defaultCount: 30 });
    expect(h.queue.items).toHaveLength(30);
    expect(h.status).toBe('no_history');
  });

  it('states: empty, no_history, done', async () => {
    const u = await newUser();
    expect((await hub(u)).status).toBe('empty');
    const done = await newUser();
    const board = await mkBoard(done);
    const [c] = await mkCards(board, 1);
    await putState(done, c!, { last: ago(1), stability: 200, due: new Date(now.getTime() + 60 * DAY) });
    await putAttempt(done, c!, ago(1));
    const h = await hub(done);
    expect(h).toMatchObject({ status: 'done', queue: { defaultCount: 0, items: [] }, kpis: { firmPct: 100 } });
  });

  it('filtered queue: boards and reasons narrow the daily queue; weak only on request; ahead = due in <= 2 days', async () => {
    const u = await newUser();
    const x = await seed(u);
    const other = await mkBoard(u, 'Outro', 'PED');
    const [o1] = await mkCards(other, 1);
    await putState(u, o1!, { last: ago(3), stability: 2, due: new Date(now.getTime() + DAY) });
    const ids = (r: Awaited<ReturnType<typeof q.getFilteredQueue>>) => (r.ok ? r.data.map((i) => i.cardId) : []);
    expect(ids(await q.getFilteredQueue(u, { reasons: ['due'] }, { now })).sort()).toEqual([x.d1, x.d2].sort());
    expect(ids(await q.getFilteredQueue(u, { boardIds: [other] }, { now }))).toEqual([]); // nothing due or new there
    expect(ids(await q.getFilteredQueue(u, { area: 'PED', ahead: true }, { now }))).toEqual([o1]);
    const withWeak = await q.getFilteredQueue(u, { reasons: ['due', 'new', 'weak'] }, { now });
    const daily = await q.getDailyQueue(u, { now });
    expect(withWeak).toEqual(daily);
    const one = await q.getFilteredQueue(u, { boardIds: [x.board], reasons: ['new'] }, { now, limit: 3 });
    expect(one.ok && one.data).toHaveLength(3);
  });

  it('cache: 60 s per user, dropped when an attempt is recorded', async () => {
    const u = await newUser();
    const x = await seed(u);
    const a = await hub(u);
    expect(await hub(u)).toEqual(a);
    const r1 = await hubm.getReviewHub(u, now);
    const r2 = await hubm.getReviewHub(u, now);
    expect(r1.ok && r2.ok && r1.data === r2.data).toBe(true); // same cached hub
    expect((await ra.recordAttempt(attempt(u, x.d2))).ok).toBe(true);
    const b = await hub(u);
    expect(b.today.reviewed).toBe(a.today.reviewed + 1);
    expect(b.queue.counts.due).toBe(1); // d2 was rescheduled
  });

  it('GET /v1/review/hub: 401 without token, 200 with the hub', async () => {
    const u = await newUser();
    await seed(u);
    expect((await app.request('/v1/review/hub')).status).toBe(401);
    const res = await app.request('/v1/review/hub', { headers: { authorization: `Bearer ${u}` } });
    expect(res.status).toBe(200);
    expect(reviewHubSchema.safeParse(((await res.json()) as { data: unknown }).data).success).toBe(true);
  });

  it('cache: any authenticated write drops it (D-643), so a new map shows up at once', async () => {
    const u = await newUser();
    const auth = { authorization: `Bearer ${u}`, 'content-type': 'application/json' };
    const get = async () => (await (await app.request('/v1/review/hub', { headers: auth })).json()).data.queue.counts.new as number;
    expect(await get()).toBe(0); // now cached for 60 s
    const b = await app.request('/v1/boards', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Novo', area: 'CM' }) });
    expect(b.status).toBeLessThan(300);
    const boardId = (await b.json()).data.id as string;
    await mkCards(boardId, 3); // direct insert: only the POST above invalidated
    expect(await get()).toBe(3);
  });

  it('start-session input accepts a filter (daily only) up to 100 items', () => {
    expect(startSessionInputSchema.safeParse({ kind: 'daily', limit: 40, filter: { reasons: ['due'], boardIds: [uuid()] } }).success).toBe(true);
    expect(startSessionInputSchema.safeParse({ kind: 'daily', filter: { reasons: [] } }).success).toBe(false);
    expect(startSessionInputSchema.safeParse({ kind: 'board', boardId: uuid(), filter: { ahead: true } }).success).toBe(false);
    expect(startSessionInputSchema.safeParse({ kind: 'daily', limit: 101 }).success).toBe(false);
  });
});
