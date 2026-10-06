// G21/F29 FR-3. DB part needs local Supabase (skipped otherwise).
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import { NoopLogger } from 'drizzle-orm/logger';
import { NoopCache } from 'drizzle-orm/cache/core';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@remoa/log';
import { createApp } from '../app';
import { perfMiddleware, perfStore, queryHash, serverTiming, timeExternal, withTiming, type PerfStore } from '.';

config({ path: '../../.env' });

const TIMING = /^db;dur=[\d.]+;desc="(\d+) q", ext;dur=[\d.]+(;desc="[^"]*")?, app;dur=[\d.]+/;

const capture = () => {
  const lines: string[] = [];
  const push = (chunk: unknown) => (lines.push(String(chunk)), true);
  const a = vi.spyOn(process.stdout, 'write').mockImplementation(push);
  const b = vi.spyOn(process.stderr, 'write').mockImplementation(push);
  return { lines, restore: () => (a.mockRestore(), b.mockRestore()) };
};

const store = (): PerfStore => ({ route: 'GET /x', log: createLogger({ requestId: 't' }), queries: 2, db: 12.34, dbWall: 10, inflight: 0, wallT0: 0, ext: 5, extNames: new Set(['stripe']), marks: new Map([['render map', 3]]) });

describe('perf headers', () => {
  const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === 'good' ? 'user-1' : null) });

  it('every response carries Server-Timing and X-Remoa-Queries (200, 401, 404)', async () => {
    for (const [path, auth] of [['/health', undefined], ['/v1/me', undefined], ['/v1/me', 'good'], ['/nope', undefined]] as const) {
      const res = await app.request(path, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
      expect(res.headers.get('server-timing'), path).toMatch(TIMING);
      expect(res.headers.get('x-remoa-queries'), path).toMatch(/^\d+$/);
    }
  });

  it('exposes both headers to the web origin (CORS)', async () => {
    const res = await app.request('/v1/me', { headers: { origin: 'http://localhost:3000', authorization: 'Bearer good' } });
    expect(res.headers.get('access-control-expose-headers')).toMatch(/server-timing.*x-remoa-queries/i);
  });

  it('serverTiming: db (wall) with query count, ext with names, app = total - db - ext, db-sum, marks', () => {
    expect(serverTiming(store(), 30)).toBe('db;dur=10;desc="2 q", ext;dur=5;desc="stripe", app;dur=15, db-sum;dur=12.3, render_map;dur=3');
    expect(serverTiming({ ...store(), extNames: new Set(), marks: new Map() }, 1)).toBe('db;dur=10;desc="2 q", ext;dur=5, app;dur=0, db-sum;dur=12.3');
  });

  it('P-449: overlapping queries (Promise.all) add up in db-sum, db stays wall time ≤ total; concurrent requests never share a store', async () => {
    const client = { unsafe: () => new Promise<unknown[]>((r) => setTimeout(() => r([]), 40)) };
    const q = () => new PostgresJsPreparedQuery(client as never, 'select 1', [], new NoopLogger(), new NoopCache(), undefined, undefined, undefined, false).execute();
    const app2 = new Hono().use(perfMiddleware).get('/p/:n', async (c) => {
      await Promise.all(Array.from({ length: Number(c.req.param('n')) }, q)); // pipelined like loadCards + loadStates in one tx
      await q();
      return c.json({});
    });
    const t0 = performance.now();
    const [a, b] = await Promise.all([app2.request('/p/4'), app2.request('/p/1')]);
    const wall = performance.now() - t0;
    const dur = (h: string, k: string) => Number(new RegExp(`(?:^|, )${k};dur=([\\d.]+)`).exec(h)![1]);
    expect(a.headers.get('x-remoa-queries')).toBe('5');
    expect(b.headers.get('x-remoa-queries')).toBe('2');
    const ha = a.headers.get('server-timing')!;
    expect(dur(ha, 'db-sum')).toBeGreaterThanOrEqual(190); // 5 × ~40 ms
    expect(dur(ha, 'db')).toBeLessThan(dur(ha, 'db-sum') / 2);
    expect(dur(ha, 'db')).toBeLessThanOrEqual(wall + 1);
    expect(dur(b.headers.get('server-timing')!, 'db-sum')).toBeLessThan(150); // only its own 2 queries
  });

  it('timeExternal and withTiming add to the request store; outside a request they just run', async () => {
    expect(await timeExternal('x', async () => 1)).toBe(1);
    const app2 = new Hono().use(perfMiddleware).get('/t', async (c) => {
      await timeExternal('ai', () => new Promise((r) => setTimeout(r, 5)));
      await withTiming('build', async () => undefined);
      return c.json({ ext: perfStore()?.ext });
    });
    const res = await app2.request('/t');
    expect(((await res.json()) as { ext: number }).ext).toBeGreaterThanOrEqual(4);
    expect(res.headers.get('server-timing')).toMatch(/ext;dur=[\d.]+;desc="ai".*build;dur=/);
  });

  it('wrapper overhead per query stays in microseconds (fake driver, no network, inside a request)', async () => {
    const client = { unsafe: () => Promise.resolve([]) };
    const q = new PostgresJsPreparedQuery(client as never, 'select 1', [], new NoopLogger(), new NoopCache(), undefined, undefined, undefined, false);
    const n = 20_000;
    let perQueryUs = 0;
    const app2 = new Hono().use(perfMiddleware).get('/b', async (c) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await client.unsafe();
      const bare = performance.now() - t0;
      const t1 = performance.now();
      for (let i = 0; i < n; i++) await q.execute();
      perQueryUs = ((performance.now() - t1 - bare) / n) * 1000;
      return c.json({});
    });
    const res = await app2.request('/b');
    expect(res.headers.get('x-remoa-queries')).toBe(String(n));
    // drizzle's own execute (tracer, placeholders, row mapping) is included: an upper bound for the wrapper.
    expect(perQueryUs).toBeLessThan(50);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('perf with the database', () => {
  afterEach(() => {
    delete process.env.PERF_SLOW_QUERY_MS;
    delete process.env.PERF_LOG_QUERIES;
  });

  const testApp = async () => {
    const dbm = await import('@remoa/db');
    return new Hono()
      .use(async (c, next) => (c.set('log' as never, createLogger({ requestId: 'perf-test' }) as never), next()))
      .use(perfMiddleware)
      .get('/n', async (c) => {
        await dbm.db.execute(sql`select 1`); // 1
        await dbm.withUser('00000000-0000-0000-0000-000000000000', async (tx) => {
          // set_config (2), then 3 and 4 (savepoint)
          await tx.execute(sql`select 2`);
          await tx.transaction(async (sp) => sp.execute(sql`select ${'secret-param-value'}::text as v`)); // savepoint query (4)
        });
        await dbm.db.select({ one: sql<number>`1` }).from(dbm.boards).limit(1); // query builder (5)
        return c.json({ ok: true });
      });
  };

  it('counts every query, inside withUser, nested transactions and the query builder', async () => {
    const res = await (await testApp()).request('/n');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-remoa-queries')).toBe('5');
    const m = TIMING.exec(res.headers.get('server-timing') ?? '');
    expect(m?.[1]).toBe('5');
    expect(Number(/db;dur=([\d.]+)/.exec(res.headers.get('server-timing')!)![1])).toBeGreaterThan(0);
  });

  it('logs slow queries above PERF_SLOW_QUERY_MS with route, hash and rows, never parameters', async () => {
    process.env.PERF_SLOW_QUERY_MS = '0';
    const app = await testApp();
    const cap = capture();
    try {
      await app.request('/n');
    } finally {
      cap.restore();
    }
    const slow = cap.lines.filter((l) => l.includes('"slow query"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(slow).toHaveLength(5);
    expect(slow[0]).toMatchObject({ level: 'warn', requestId: 'perf-test', route: 'GET /n', hash: queryHash('select 1'), rows: 1 });
    expect(cap.lines.join('')).not.toContain('secret-param-value');
  });

  it('default threshold stays quiet; PERF_LOG_QUERIES=1 logs every query at info', async () => {
    const app = await testApp();
    let cap = capture();
    try {
      await app.request('/n');
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes('"query"') || l.includes('"slow query"'))).toHaveLength(0);
    process.env.PERF_LOG_QUERIES = '1';
    cap = capture();
    try {
      await app.request('/n');
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes('"msg":"query"'))).toHaveLength(5);
  });

  it('warns in dev when a route passes its FR-19 query budget', async () => {
    const dbm = await import('@remoa/db');
    const app = new Hono().use(perfMiddleware).get('/v1/calendar/events', async (c) => {
      for (let i = 0; i < 4; i++) await dbm.db.execute(sql`select 1`);
      return c.json({});
    });
    const cap = capture();
    try {
      await app.request('/v1/calendar/events');
    } finally {
      cap.restore();
    }
    expect(cap.lines.find((l) => l.includes('query budget exceeded'))).toMatch(/"queries":4,"budget":3/);
  });
});
