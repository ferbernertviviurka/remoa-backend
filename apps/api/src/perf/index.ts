// G21/F29 FR-3 (D-981..D-984): per-request performance counters. No behavior change: wrappers only measure.
// One AsyncLocalStorage store per request counts DB queries + DB time, external time (fetch/Stripe/R2) and named marks;
// the middleware turns it into `Server-Timing` + `X-Remoa-Queries` (read by `perf:bench`, T2).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { PostgresJsPreparedQuery, PostgresJsSession } from 'drizzle-orm/postgres-js';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import { createLogger, type Logger } from '@remoa/log';
import { isProduction, perfEnv } from '@remoa/config';

/**
 * `db` = sum of every query's time; `dbWall` = time with at least one query in flight (P-449: Promise.all inside a transaction
 * pipelines on one connection, so each query also waits for its siblings and the sum can exceed the request's total).
 */
export type PerfStore = { route: string; log: Logger; queries: number; db: number; dbWall: number; inflight: number; wallT0: number; ext: number; extNames: Set<string>; marks: Map<string, number> };

/** FR-19: query budget per route (`METHOD /path` as Hono matches it). The one place; the dev warning and the bench read it. */
export const QUERY_BUDGETS: Record<string, number> = {
  'GET /v1/home': 8, // Hoje
  'GET /v1/boards': 4, // Biblioteca
  'GET /v1/review/hub': 6, // Revisar
  'GET /v1/review/queue': 6, // Revisar (fila)
  'GET /v1/boards/:id': 5, // abrir mapa
  'POST /v1/challenge/rate': 4, // responder card (uma transação)
  'GET /v1/calendar/events': 4, // Calendário (mês); D-1094: reminders + covers always pipelined with the rows (1 round trip, +1 query)
  'GET /v1/notifications': 3, // Notificações
  'GET /v1/admin/overview': 6, // Admin (visão geral)
};

// On globalThis: vitest/tsx reload this module while drizzle-orm (patched once) stays cached; both must see the same store.
const G = globalThis as typeof globalThis & { __remoaPerf?: AsyncLocalStorage<PerfStore> };
const als = (G.__remoaPerf ??= new AsyncLocalStorage<PerfStore>());
export const perfStore = () => als.getStore();

const ms = (t0: number) => performance.now() - t0;
/** Short, stable id of a parameterized query: the text never carries values (drizzle binds them as $1..$n). */
export const queryHash = (q: string) => createHash('sha1').update(q).digest('hex').slice(0, 12);

function recordQuery(query: string, dur: number, rows: number | undefined) {
  const s = als.getStore();
  if (s) {
    s.queries++;
    s.db += dur;
  }
  const { slowQueryMs, logQueries } = perfEnv();
  if (!logQueries && dur < slowQueryMs) return;
  const log = s?.log ?? createLogger({ requestId: 'no-request' });
  log[dur >= slowQueryMs ? 'warn' : 'info'](dur >= slowQueryMs ? 'slow query' : 'query', { route: s?.route, hash: queryHash(query), ms: Math.round(dur * 10) / 10, rows });
}

async function timedQuery<T>(query: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const s = als.getStore();
  if (s && s.inflight++ === 0) s.wallT0 = t0;
  let rows: number | undefined;
  try {
    const r = await run();
    if (Array.isArray(r)) rows = r.length;
    return r;
  } finally {
    if (s && --s.inflight === 0) s.dbWall += ms(s.wallT0);
    recordQuery(query, ms(t0), rows);
  }
}

// The single DB hook: every drizzle query (db.*, tx.* inside withUser/transactions, db.query.*, execute) ends in one of these
// four methods of the postgres-js driver. BEGIN/COMMIT (client.begin) are not counted: they are not app queries.
// ponytail: prototype patch, tied to drizzle-orm 0.45's postgres-js session; perf/index.test.ts fails if an upgrade moves it.
type Fn = (...a: unknown[]) => Promise<unknown>;
function patch(proto: object, name: string, queryOf: (self: unknown, args: unknown[]) => string) {
  const p = proto as Record<string, Fn | boolean>;
  const flag = `__remoaPerf_${name}`;
  if (p[flag]) return;
  const orig = p[name] as Fn;
  p[name] = function (this: unknown, ...args: unknown[]) {
    return timedQuery(queryOf(this, args), () => orig.apply(this, args));
  };
  p[flag] = true;
}
const preparedSql = (self: unknown) => (self as { queryString: string }).queryString;
const firstArg = (_: unknown, args: unknown[]) => String(args[0]);
patch(PostgresJsPreparedQuery.prototype, 'execute', preparedSql);
patch(PostgresJsPreparedQuery.prototype, 'all', preparedSql);
patch(PostgresJsSession.prototype, 'query', firstArg);
patch(PostgresJsSession.prototype, 'queryObjects', firstArg);

/** Adds already-measured external time (e.g. Stripe's `response` event). */
export function addExternal(name: string, dur: number) {
  const s = als.getStore();
  if (!s) return;
  s.ext += dur;
  s.extNames.add(name);
}

/** Times a call to an outside service (Stripe, AI, e-mail, R2, Inngest, fetch) into the request's `ext` bucket. */
export async function timeExternal<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    addExternal(name, ms(t0));
  }
}

/** Times any block as its own `Server-Timing` metric (`name;dur=`). Outside a request it only runs fn. */
export async function withTiming<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const s = als.getStore();
    if (s) s.marks.set(name, (s.marks.get(name) ?? 0) + ms(t0));
  }
}

// Every outbound fetch (OpenRouter, Resend, Inngest, Supabase Auth/JWKS, web revalidation, IndexNow) counts as external time.
// Time to response headers; a streamed body is not included. Parallel calls add up (ext can exceed wall time).
const GF = globalThis as typeof globalThis & { __remoaPerfFetch?: true };
if (!GF.__remoaPerfFetch) {
  const orig = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (!als.getStore()) return orig(input, init);
    const url = input instanceof Request ? input.url : String(input);
    return timeExternal(URL.canParse(url) ? new URL(url).host : 'fetch', () => orig(input, init));
  };
  GF.__remoaPerfFetch = true;
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
/**
 * `db;dur=X;desc="N q", ext;dur=Y, app;dur=Z, db-sum;dur=W` (+ withTiming marks). db = wall time with a query in flight (≤ total);
 * db-sum = the old per-query sum (> db when queries overlap). app = total − db − ext, floored at 0.
 */
export function serverTiming(s: PerfStore, total: number) {
  const parts = [`db;dur=${f1(s.dbWall)};desc="${s.queries} q"`, `ext;dur=${f1(s.ext)}${s.extNames.size ? `;desc="${[...s.extNames].join(',')}"` : ''}`, `app;dur=${f1(Math.max(0, total - s.dbWall - s.ext))}`, `db-sum;dur=${f1(s.db)}`];
  for (const [k, v] of s.marks) parts.push(`${k.replace(/[^\w-]/g, '_')};dur=${f1(v)}`);
  return parts.join(', ');
}

/** Runs the rest of the chain inside a fresh store and writes the two headers on every response (404 and errors included). */
export const perfMiddleware = createMiddleware<{ Variables: { log: Logger } }>(async (c, next) => {
  const route = `${c.req.method} ${routePath(c, -1)}`;
  const s: PerfStore = { route, log: c.get('log') ?? createLogger({ requestId: 'no-request' }), queries: 0, db: 0, dbWall: 0, inflight: 0, wallT0: 0, ext: 0, extNames: new Set(), marks: new Map() };
  const t0 = performance.now();
  await als.run(s, () => next());
  const value = serverTiming(s, ms(t0));
  try {
    c.res.headers.set('server-timing', value);
    c.res.headers.set('x-remoa-queries', String(s.queries));
  } catch {
    // immutable headers (a proxied Response): copy once
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('server-timing', value);
    c.res.headers.set('x-remoa-queries', String(s.queries));
  }
  const budget = QUERY_BUDGETS[route];
  if (budget !== undefined && s.queries > budget && !isProduction()) s.log.warn('query budget exceeded', { route, queries: s.queries, budget });
});
