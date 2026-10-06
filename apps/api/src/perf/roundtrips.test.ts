// G21 D-1090–D-1095 (CCR-059): round trips to the database per request, the number that sets latency when the API is far from the
// database (Railway US East ↔ Supabase São Paulo, ~124 ms, D-1084). An in-process TCP proxy delays every packet DELAY ms each way;
// a request's round trips = its wall time ÷ the measured round trip of `select 1`, rounded (the local work is a few ms). Each route is warmed first (prepared
// statements are cached per connection: the first use of a statement pays one more trip), then the best of 3 is taken.
// Needs a database (skipped without DATABASE_URL), like budget.test.ts.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeToken } from '../admin/core/test-helpers';
import type { VerifyToken } from '../app';

config({ path: '../../.env' });

const DELAY = 40; // ms each way: large next to local CPU noise (CI runs 3 test files at once)
/** Round trips per route (each ~124 ms in production; target p95 < 800 ms). Before D-1090–D-1095: 4–12, `start` 32 (BASELINE.md, Final 2). */
export const ROUND_TRIPS: Record<string, number> = {
  'GET /v1/home': 1,
  'GET /v1/boards': 1, // +1 when a map_stats row is stale (upsert)
  'GET /v1/coverage': 1,
  'GET /v1/onboarding': 2, // server-connection reads, then the session check (D-990)
  'GET /v1/calendar/upcoming': 1,
  'GET /v1/review/queue': 1,
  'GET /v1/review/retrievability': 1,
  'GET /v1/review/hub': 2, // 1, +1 when a map_stats row is stale (upsert)
  'GET /v1/reports/progress': 1,
  'GET /v1/boards/:id': 1,
  'POST /v1/challenge/start': 3, // queue, item context, insert + COMMIT (D-1094)
  'POST /v1/challenge/answer': 2, // session lock, save + COMMIT
  'POST /v1/challenge/rate': 2, // session + FSRS locks, write CTE + COMMIT
  'GET /v1/calendar/events': 1,
  'GET /v1/calendar/labels': 1,
  'GET /v1/notifications': 1,
  'GET /v1/notifications/unread-count': 1,
};

function delayProxy(target: URL) {
  // strictly in order: one FIFO and one timer per direction (independent timers per chunk can reorder the stream)
  const pipe = (from: net.Socket, to: net.Socket) => {
    const q: { at: number; buf: Buffer | null }[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      while (q.length && q[0]!.at <= Date.now()) {
        const x = q.shift()!;
        if (x.buf) { if (to.writable) to.write(x.buf); }
        else to.destroy();
      }
      if (q.length) timer = setTimeout(flush, Math.max(0, q[0]!.at - Date.now()));
    };
    const push = (buf: Buffer | null) => {
      q.push({ at: Date.now() + DELAY, buf });
      timer ??= setTimeout(flush, DELAY);
    };
    from.on('data', push);
    from.once('close', () => push(null));
    from.on('error', () => undefined);
  };
  const server = net.createServer((c) => {
    c.setNoDelay(true);
    const s = net.connect(Number(target.port || 5432), target.hostname);
    s.setNoDelay(true);
    pipe(c, s);
    pipe(s, c);
  });
  return new Promise<net.Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe.skipIf(!process.env.DATABASE_URL)('round trips to the database per request (D-1090–D-1095)', () => {
  const direct = process.env.DATABASE_URL!;
  let proxy: net.Server;
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  const sessions = new Map<string, string>();
  const ids: string[] = [];
  let student = '';
  let boardId = '';
  const trips: Record<string, number> = {};
  const verifyToken: VerifyToken = async (t, opts) => {
    const sub = (JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString()) as { sub: string }).sub;
    const sessionId = sessions.get(sub);
    if (!sessionId) return null;
    if (opts?.defer) return { userId: sub, sessionId, pending: true };
    const { liveSession } = await import('../auth-session');
    const live = await liveSession(sub, sessionId);
    return live && { userId: sub, sessionId, account: live.account };
  };
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { authorization: `Bearer ${fakeToken(student)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const timed = async (method: string, path: string, body?: unknown) => {
    await new Promise((r) => setTimeout(r, 6 * DELAY)); // a read's COMMIT is not awaited: let its connection go back to the pool first
    const t0 = performance.now();
    const res = await call(method, path, body);
    const text = await res.text();
    const ms = performance.now() - t0;
    expect(res.status, `${method} ${path} -> ${text}`).toBe(200);
    return { ms, json: JSON.parse(text) as { data: Record<string, unknown> } };
  };
  let rtt = 2 * DELAY; // calibrated in beforeAll: a `select 1` through the proxy (timer overhead included)
  const tripsOf = (ms: number) => Math.round(ms / rtt);

  beforeAll(async () => {
    proxy = await delayProxy(new URL(direct));
    const u = new URL(direct);
    u.hostname = '127.0.0.1';
    u.port = String((proxy.address() as net.AddressInfo).port);
    process.env.DATABASE_URL = u.toString(); // before @remoa/db is imported: every connection of this file goes through the proxy
    dbm = await import('@remoa/db');
    app = (await import('../app')).createApp({ webOrigin: 'http://localhost:3000', verifyToken });
    const one: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      await dbm.db.execute(sql`select 1`);
      one.push(performance.now() - t0);
    }
    rtt = one.sort((a, b) => a - b)[6]!;
    student = uuid();
    ids.push(student);
    sessions.set(student, uuid());
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${student}', '${student}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dbm.db.execute(sql`insert into auth.sessions (id, user_id, created_at, updated_at) values (${sessions.get(student)}, ${student}, now(), now())`);
    boardId = (await dbm.db.insert(dbm.boards).values({ userId: student, title: 'Mapa' }).returning())[0]!.id;
    const cards = await dbm.db.insert(dbm.cards).values(Array.from({ length: 30 }, (_, i) => ({ boardId, type: 'concept' as const, title: `c${i}`, front: `f${i}`, back: `b${i}`, payload: {}, order: i }))).returning();
    await dbm.db.insert(dbm.edges).values(cards.slice(1).map((c, i) => ({ boardId, fromCardId: cards[i]!.id, toCardId: c.id, label: i % 2 ? 'causa' : null })));
    const last = new Date(Date.now() - 6 * 86_400_000);
    await dbm.db.insert(dbm.fsrsState).values(cards.slice(0, 20).map((c) => ({ userId: student, cardId: c.id, subId: '', stability: 5, difficulty: 5, due: new Date(Date.now() - 86_400_000), reps: 3, lapses: 0, lastReview: last, state: 'review' as const, scheduledDays: 5, createdAt: last })));
  }, 60_000);
  afterAll(async () => {
    if (process.env.PERF_TRIPS_PRINT) process.stdout.write(`${JSON.stringify(trips)}\n`);
    if (dbm && ids.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${ids.map((x) => `'${x}'`).join(',')})`));
    await dbm?.db.$client.end({ timeout: 1 });
    proxy?.close();
    process.env.DATABASE_URL = direct;
  });

  const month = () => { const d = new Date(); const p = (x: number) => String(x).padStart(2, '0'); return `from=${d.getFullYear()}-${p(d.getMonth() + 1)}-01&to=${d.getFullYear()}-${p(d.getMonth() + 1)}-28`; };
  const gets: [string, () => string][] = [
    ['GET /v1/home', () => '/v1/home'],
    ['GET /v1/boards', () => '/v1/boards'],
    ['GET /v1/coverage', () => '/v1/coverage'],
    ['GET /v1/onboarding', () => '/v1/onboarding'],
    ['GET /v1/calendar/upcoming', () => '/v1/calendar/upcoming?limit=4'],
    ['GET /v1/review/queue', () => '/v1/review/queue'],
    ['GET /v1/review/retrievability', () => `/v1/review/retrievability?boardId=${boardId}`],
    ['GET /v1/review/hub', () => '/v1/review/hub'],
    ['GET /v1/reports/progress', () => '/v1/reports/progress'],
    ['GET /v1/boards/:id', () => `/v1/boards/${boardId}`],
    ['GET /v1/calendar/events', () => `/v1/calendar/events?${month()}`],
    ['GET /v1/calendar/labels', () => '/v1/calendar/labels'],
    ['GET /v1/notifications', () => '/v1/notifications'],
    ['GET /v1/notifications/unread-count', () => '/v1/notifications/unread-count'],
  ];
  for (const [key, path] of gets)
    it(`${key}: <= ${ROUND_TRIPS[key]} round trips`, async () => {
      process.env.CACHE_DISABLED = '1'; // the database path, not the L1 cache
      try {
        for (let i = 0; i < 4; i++) await timed('GET', path()); // every pooled connection has the route's statements prepared
        const best = Math.min(...[await timed('GET', path()), await timed('GET', path()), await timed('GET', path())].map((x) => x.ms));
        trips[key] = tripsOf(best);
      } finally {
        delete process.env.CACHE_DISABLED;
      }
      expect(trips[key], `${key}: ${trips[key]} round trips`).toBeLessThanOrEqual(ROUND_TRIPS[key]!);
    }, 30_000);

  it('POST /v1/challenge/start, answer and rate', async () => {
    const body = { kind: 'board', boardId, limit: 12 };
    for (let i = 0; i < 4; i++) await timed('POST', '/v1/challenge/start', body);
    const starts = [await timed('POST', '/v1/challenge/start', body), await timed('POST', '/v1/challenge/start', body), await timed('POST', '/v1/challenge/start', body)];
    trips['POST /v1/challenge/start'] = tripsOf(Math.min(...starts.map((x) => x.ms)));
    const s = starts[2]!.json.data as { sessionId: string; items: { id: string }[] };
    const answer: number[] = [];
    const rate: number[] = [];
    for (const it of s.items.slice(0, 4)) {
      answer.push((await timed('POST', '/v1/challenge/answer', { inputKind: 'self', sessionId: s.sessionId, itemId: it.id, durationMs: 4000 })).ms);
      rate.push((await timed('POST', '/v1/challenge/rate', { sessionId: s.sessionId, itemId: it.id, grade: 'good', overridden: false })).ms);
    }
    trips['POST /v1/challenge/answer'] = tripsOf(Math.min(...answer.slice(1)));
    trips['POST /v1/challenge/rate'] = tripsOf(Math.min(...rate.slice(1)));
    for (const k of ['POST /v1/challenge/start', 'POST /v1/challenge/answer', 'POST /v1/challenge/rate']) expect(trips[k], `${k}: ${trips[k]} round trips`).toBeLessThanOrEqual(ROUND_TRIPS[k]!);
  }, 60_000);
});
