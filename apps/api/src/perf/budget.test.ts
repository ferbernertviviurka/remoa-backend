// G21 FR-19/FR-55 (P-482): query budget per route as an integration test. One user with minimal data hits every route of QUERY_BUDGETS
// and `X-Remoa-Queries` (BEGIN/COMMIT not counted, same as the T1 counter) must stay within the budget. Needs a database (skipped without
// DATABASE_URL). First (cold) request of each route: that is the worst case. A red route here is a real budget breach, not a flaky test.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveSession } from '../auth-session';
import { fakeToken } from '../admin/core/test-helpers';
import type { VerifyToken } from '../app';
import { QUERY_BUDGETS } from '.';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('FR-19 query budget per route', () => {
  const ids: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let student = '';
  let admin = '';
  let boardId = '';
  let sessionId = '';
  let itemId = '';
  const counts: Record<string, number> = {};
  const sessions = new Map<string, string>();
  // like production (D-990): GET = signature only, the session query rides in the request's first statement; writes run liveSession themselves
  const verifyToken: VerifyToken = async (t, opts) => {
    const sub = (JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString()) as { sub: string }).sub;
    const sessionId = sessions.get(sub);
    if (!sessionId) return null;
    if (opts?.defer) return { userId: sub, sessionId, pending: true };
    const live = await liveSession(sub, sessionId);
    return live && { userId: sub, sessionId, account: live.account };
  };

  const newUser = async (role?: 'admin') => {
    const id = uuid();
    ids.push(id);
    sessions.set(id, uuid());
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dbm.db.execute(sql`insert into auth.sessions (id, user_id, created_at, updated_at) values (${sessions.get(id)}, ${id}, now(), now())`);
    if (role) await dbm.db.execute(sql`update profiles set role = ${role} where user_id = ${id}`);
    return id;
  };
  const call = (as: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer ${fakeToken(as)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const measure = async (key: string, as: string, method: string, path: string, body?: unknown) => {
    const res = await call(as, method, path, body);
    expect(res.status, `${key} -> ${await res.clone().text()}`).toBe(200);
    const n = Number(res.headers.get('x-remoa-queries'));
    counts[key] = n;
    return { n, json: (await res.json()) as { data?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken });
    student = await newUser();
    admin = await newUser('admin');
    // minimal data: a board with 10 cards (CHALLENGE_MIN_CARDS) of which 3 concepts are due for review
    boardId = (await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Mapa' }).returning())[0]!.id;
    const cards = await dbm.db.insert(dbm.cards).values(Array.from({ length: 10 }, (_, i) => ({ boardId, type: 'concept' as const, title: `c${i}`, front: `f${i}`, back: `b${i}`, payload: {}, order: i }))).returning();
    const last = new Date(Date.now() - 6 * 86_400_000);
    await dbm.db.insert(dbm.fsrsState).values(cards.slice(0, 3).map((c) => ({ userId: student, cardId: c.id, subId: '', stability: 5, difficulty: 5, due: new Date(Date.now() - 86_400_000), reps: 3, lapses: 0, lastReview: last, state: 'review' as const, scheduledDays: 5, createdAt: last })));
    // the session is started in beforeAll: only `rate` is under budget in this file (start has no budget)
    const start = await call(student, 'POST', '/v1/challenge/start', { kind: 'board', boardId });
    const s = ((await start.json()) as { data: { sessionId: string; items: { id: string }[] } }).data;
    sessionId = s.sessionId;
    itemId = s.items[0]!.id;
    const ans = await call(student, 'POST', '/v1/challenge/answer', { inputKind: 'self', sessionId, itemId, durationMs: 4000 });
    expect(ans.status).toBe(200);
  });
  afterAll(async () => {
    if (process.env.PERF_BUDGET_PRINT) console.log(JSON.stringify(counts));
    if (dbm && ids.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${ids.map((u) => `'${u}'`).join(',')})`));
  });

  const case_ = (key: string, as: () => string, method: string, path: () => string, body?: () => unknown) =>
    it(`${key} <= ${QUERY_BUDGETS[key]}`, async () => {
      const { n } = await measure(key, as(), method, path(), body?.());
      expect(n, `${key}: ${n} queries, budget ${QUERY_BUDGETS[key]}`).toBeLessThanOrEqual(QUERY_BUDGETS[key]!);
    });

  const month = () => { const d = new Date(); const p = (x: number) => String(x).padStart(2, '0'); return `from=${d.getFullYear()}-${p(d.getMonth() + 1)}-01&to=${d.getFullYear()}-${p(d.getMonth() + 1)}-28`; };
  case_('GET /v1/home', () => student, 'GET', () => '/v1/home');
  case_('GET /v1/boards', () => student, 'GET', () => '/v1/boards');
  case_('GET /v1/review/hub', () => student, 'GET', () => '/v1/review/hub');
  case_('GET /v1/review/queue', () => student, 'GET', () => '/v1/review/queue');
  case_('GET /v1/boards/:id', () => student, 'GET', () => `/v1/boards/${boardId}`);
  case_('POST /v1/challenge/rate', () => student, 'POST', () => '/v1/challenge/rate', () => ({ sessionId, itemId, grade: 'good', overridden: false }));
  case_('GET /v1/calendar/events', () => student, 'GET', () => `/v1/calendar/events?${month()}`);
  case_('GET /v1/notifications', () => student, 'GET', () => '/v1/notifications');
  case_('GET /v1/admin/overview', () => admin, 'GET', () => '/v1/admin/overview');

  it('every budget in QUERY_BUDGETS has a case here', () => {
    const covered = new Set(['GET /v1/home', 'GET /v1/boards', 'GET /v1/review/hub', 'GET /v1/review/queue', 'GET /v1/boards/:id', 'POST /v1/challenge/rate', 'GET /v1/calendar/events', 'GET /v1/notifications', 'GET /v1/admin/overview']);
    expect(Object.keys(QUERY_BUDGETS).sort()).toEqual([...covered].sort());
  });
});
