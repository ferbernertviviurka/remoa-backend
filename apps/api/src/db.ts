import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { ok, type AppError, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createLogger } from '@remoa/log';
import { liveSessionSql, SessionRejected, sessionGate, settleGate, type SessionRow } from './auth-session';
import { perfStore } from './perf';

// Lazy: importing @remoa/db throws without DATABASE_URL, and app.test.ts must load the app without a database.
export const dbm = () => import('@remoa/db');

/** G21 FR-25 (D-993): per transaction (SET LOCAL), so they never leak to the next user of the pooled connection. */
export const TIMEOUTS = { app: { statementMs: 5_000, idleTxMs: 10_000 }, job: { statementMs: 30_000, idleTxMs: 60_000 } } as const;
const jobScope = new AsyncLocalStorage<true>();
/** Inngest functions and cron bodies run inside this: their run() transactions get the job timeouts. */
export const asJob = <T>(fn: () => T): T => jobScope.run(true, fn);
export const currentTimeouts = () => (jobScope.getStore() ? TIMEOUTS.job : TIMEOUTS.app);

/**
 * The first (and only fixed) statement of every run(): RLS claims + role (same as @remoa/db withUser) + the timeouts, and, when the
 * request still owes its session check (D-990), the liveSession columns through a left join (one row either way).
 * The auth.* reads are planned and permission-checked as the connection role before any set_config runs (executor start), so
 * switching to `authenticated` in the same statement does not hide them.
 */
export function firstStatement(userId: string, t: { statementMs: number; idleTxMs: number }, sessionId?: string): SQL {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  const setup = sql`set_config('request.jwt.claims', ${claims}, true), set_config('role', 'authenticated', true),
    set_config('statement_timeout', ${String(t.statementMs)}, true), set_config('idle_in_transaction_session_timeout', ${String(t.idleTxMs)}, true),
    set_config('plan_cache_mode', 'force_custom_plan', true)`; // D-1090: prepared, but planned per call with the values (as unnamed ones were)
  if (!sessionId) return sql`select ${setup}`;
  return sql`select ${setup}, ls.live, ls.deleted_at, ls.suspended_at, ls.has_profile from (select 1) one left join (${liveSessionSql(userId, sessionId)}) ls on true`;
}

type Dbm = typeof import('@remoa/db');
type Reserved = Awaited<ReturnType<Dbm['db']['$client']['reserve']>>;
const dialect = new PgDialect();
const log = () => perfStore()?.log ?? createLogger({ requestId: 'no-request' });
/** Statements that may change data. Anything else is a read: its COMMIT is sent but not waited for (G21 D-1091). */
export const WRITES = /\b(insert|update|delete|merge|truncate|nextval|setval|pg_advisory_xact_lock|rebuild_\w+)\b/i;

type RunCtx = { gate: Promise<unknown>; final: <R>(q: PromiseLike<R>) => Promise<R> };

/**
 * D-1106 (P-531): the first use of a statement on a connection pays one more round trip (Describe) and holds the rest of the flight;
 * with the pool handing out its idle connections in turn, every statement was cold up to 10 times after a deploy (p95 1–1,8 s on the
 * first pass). run() remembers each parameterized statement it sends (text + argument kinds: postgres.js keys its cache on both).
 * A new one wakes `warmIdle()`, which takes the pool's idle connections one at a time (never more than one held) and prepares there
 * what they lack; a run() also prepares up to WARM_PER_RUN after its transaction ends, before its connection goes back to the pool.
 * No request waits on either. ponytail: one Describe round trip per statement and connection, in the background; process-wide caps;
 * pids of closed connections stay in `warmOn` (a handful per day).
 */
const WARM_PER_RUN = 4;
let warming: Promise<void> | undefined;
let again = false;
function warmIdle(m: Dbm) {
  if (warming) return void (again = true);
  warming = (async () => {
    do {
      again = false;
      for (let i = 0; i < m.db.$client.options.max; i++) {
        const r = await m.db.$client.reserve(); // the longest idle connection
        try {
          const q = r.unsafe('select 1');
          await q;
          await shareStatements(r, (q as unknown as { state?: { pid?: number } }).state?.pid, new Set(), Infinity);
        } finally {
          r.release();
        }
      }
    } while (again);
  })().catch(() => undefined).finally(() => (warming = undefined));
}
const learned = new Map<string, { q: string; args: unknown[] }>();
const warmOn = new Map<number, Set<string>>(); // backend pid -> statements it has prepared
const shape = (x: unknown): unknown => (x instanceof Date ? new Date(0) : typeof x === 'boolean' ? false : typeof x === 'bigint' ? 0n
  : x instanceof Uint8Array ? new Uint8Array() : Array.isArray(x) ? [shape(x[0])] : null); // same inferred type, no user data kept
const kindOf = (x: unknown): string => (x instanceof Date ? 'd' : typeof x === 'boolean' ? 'b' : typeof x === 'bigint' ? 'n'
  : x instanceof Uint8Array ? 'u' : Array.isArray(x) ? `a${kindOf(x[0])}` : '0');
async function shareStatements(r: Reserved, pid: number | undefined, used: Set<string>, cap = WARM_PER_RUN) {
  if (!pid) return;
  const have = warmOn.get(pid) ?? new Set<string>();
  warmOn.set(pid, have);
  for (const k of used) have.add(k);
  let n = 0;
  for (const [k, s] of learned) {
    if (n >= cap) break;
    if (have.has(k)) continue;
    have.add(k);
    n++;
    await (r.unsafe(s.q, s.args as never[], { prepare: true }) as unknown as { describe: () => Promise<unknown> }).describe().catch(() => undefined);
  }
}
/**
 * D-1123: prepares every statement run() has learned so far on every pooled connection, all connections at once (boot warm-up: no
 * request is waiting yet, unlike warmIdle). The driver waits for each Describe, so it costs ~1 round trip per statement, in parallel.
 */
export async function warmStatements() {
  const c = (await dbm()).db.$client;
  const held = await Promise.all(Array.from({ length: c.options.max }, () => c.reserve()));
  try {
    await Promise.all(held.map(async (r) => {
      const q = r.unsafe('select 1');
      await q;
      await shareStatements(r, (q as unknown as { state?: { pid?: number } }).state?.pid, new Set(), Infinity);
    }));
  } finally {
    for (const r of held) r.release();
  }
}
const runCtx = new AsyncLocalStorage<RunCtx>();
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Resolves once every query already started in this tick is on its connection (call order = wire order from here on). */
export const onWire = tick;

/**
 * G21 D-1091 (CCR-059): one transaction in as few round trips as the driver allows (RTT API → banco ~124 ms in production, D-1084).
 * BEGIN, the fixed first statement and the first statement of `fn` leave in the same flight (postgres.js pipelines on one connection;
 * with `prepare: true`, D-1090, a parameterized query no longer waits for its own Describe). A transaction that sent no write
 * statement (`WRITES`) answers without waiting for its COMMIT: the connection goes back to the pool only once COMMIT returns.
 * Order on the wire is the order of the calls: BEGIN and the first statement are handed to the connection before `fn` starts
 * (setImmediate: every microtask of the driver chain has run), so no statement of `fn` can run before the role switch.
 * ponytail: if BEGIN itself failed on a live connection the next statements would run in autocommit; BEGIN on an idle connection
 * only fails when the connection is gone, and then every pipelined statement fails with it.
 */
async function pipelined<T, F>(m: Dbm, first: SQL, fn: (tx: Tx, first: Promise<F[]>) => Promise<T>): Promise<T> {
  const r: Reserved = await m.db.$client.reserve();
  let wrote = false;
  let commit: Promise<unknown> | undefined; // set by final(): COMMIT already sent behind the last statement
  const used = new Set<string>();
  const client = new Proxy(m.prepared(r), {
    get: (t, p) => (p === 'unsafe'
      ? (q: string, ...a: unknown[]) => {
          if (commit) throw new Error('run(): statement after final()'); // would run outside the transaction, as the server role
          wrote ||= WRITES.test(q);
          const args = (a[0] ?? []) as unknown[];
          if (args.length) {
            const k = `${args.map(kindOf).join(',')}|${q}`;
            used.add(k);
            if (!learned.has(k) && learned.size < 1_000) {
              learned.set(k, { q, args: args.map(shape) });
              setTimeout(() => warmIdle(m), 50); // after this request has its answer
            }
          }
          return (t.unsafe as (...x: unknown[]) => unknown)(q, ...a);
        }
      : Reflect.get(t, p)),
  });
  const rel = { fullSchema: m.db._.fullSchema, schema: m.db._.schema!, tableNamesMap: m.db._.tableNamesMap };
  const tx = new PostgresJsTransaction(dialect, new PostgresJsSession(client as never, dialect, rel, {}) /* a reserved connection: no savepoint() (no nested tx.transaction in run) */, rel) as unknown as Tx;
  const end = (q: 'commit' | 'rollback') => {
    const ended = Promise.resolve(commit ?? r.unsafe(q));
    // D-1106: back to the pool only after sharing statements (never awaited by the request)
    void ended.then(() => shareStatements(r, (bq as { state?: { pid?: number } }).state?.pid ?? undefined, used), () => undefined).catch(() => undefined).finally(() => r.release());
    const done = ended.then(() => undefined);
    if (wrote) return done;
    done.catch((e: unknown) => log().error('transaction end failed', { q, error: e instanceof Error ? e.message : String(e) }));
  };
  const final = async <R>(q: PromiseLike<R>) => {
    const p = Promise.resolve(q);
    await tick(); // q is on the connection: COMMIT goes right behind it, same flight (if q fails, Postgres turns COMMIT into ROLLBACK)
    commit = r.unsafe('commit').then(() => undefined);
    commit.catch(() => undefined);
    return p;
  };
  const bq = r.unsafe('begin'); // its `state` names the backend (pid) once sent
  const begin = bq.then(() => undefined);
  const head = Promise.resolve(tx.execute(first) as PromiseLike<F[]>); // one execution (a drizzle query re-runs on every then)
  head.catch(() => undefined); // read below; a failure here also fails fn's statements (aborted transaction)
  await tick();
  const [b, out] = await Promise.allSettled([begin.then(() => head), runCtx.run({ gate: head, final }, () => fn(tx, head))]);
  const fail = b.status === 'rejected' ? b.reason : out.status === 'rejected' ? out.reason : undefined;
  if (b.status === 'rejected' || out.status === 'rejected') {
    await end('rollback')?.catch(() => undefined); // the first error is the one to report
    throw fail;
  }
  await end('commit');
  return out.value;
}

/**
 * D-1092: sends `q` and COMMIT in the same flight and returns q's result. Only as the last statement of a run() body, and nothing after
 * it may throw (a later throw would no longer roll back): a further statement throws. Outside run(): just `q`.
 */
export const final = <R>(q: PromiseLike<R>): Promise<R> => runCtx.getStore()?.final(q) ?? Promise.resolve(q);

/**
 * D-1093: inside run() on a FUSED_WRITES route, resolves once the request's session check (first statement) has passed and throws
 * SessionRejected otherwise. Costs nothing once fn's first statement returned (same connection, answered in order). Call it before
 * anything outside this transaction (another connection, an outside service).
 */
export const sessionChecked = (): Promise<unknown> => runCtx.getStore()?.gate ?? Promise.resolve();

/** withUser() of @remoa/db plus FR-25 timeouts and the fused session check (D-990/D-991), pipelined (D-1091). */
export const run = async <T>(userId: string, fn: (tx: Tx, s: typeof import('@remoa/db')) => Promise<T>) => {
  const m = await dbm();
  const g = sessionGate.getStore();
  const owed = g && g.state !== 'ok' && g.userId === userId ? g : undefined;
  if (owed && owed.state !== 'pending') throw new SessionRejected(owed.state as AppError); // already refused earlier in this request: no round trip
  return pipelined<T, SessionRow>(m, firstStatement(userId, currentTimeouts(), owed?.state === 'pending' ? owed.sessionId : undefined), async (tx, head) => {
    const gate = owed ? head.then(([r]) => settleGate(owed, owed.state === 'pending' ? r : undefined)) : head;
    gate.catch(() => undefined);
    // fn always runs to its end before the transaction ends (allSettled): nothing of it may reach the connection after ROLLBACK
    const [out, checked] = await Promise.allSettled([runCtx.run({ ...runCtx.getStore()!, gate }, () => fn(tx, m)), gate]);
    if (checked.status === 'rejected') throw checked.reason;
    if (out.status === 'rejected') throw out.reason;
    return out.value;
  });
};

/**
 * D-1096: opens every pooled connection at boot. A new connection costs ~6 round trips (TCP, TLS, auth, type fetch: ~0,75 s with the
 * database 124 ms away), which the first requests after a deploy otherwise paid. Recycling is rare and staggered (6–12 h, D-1103).
 * D-1123: the statements themselves are prepared at boot by `warmUp()` (warmup.ts) before /health turns 200.
 */
export async function warmPool() {
  const c = (await dbm()).db.$client;
  const held = await Promise.all(Array.from({ length: c.options.max }, () => c.reserve()));
  for (const r of held) r.release();
}

/**
 * D-1105 (P-533): a list as ONE array parameter, for `col = any(${uuids(ids)})` instead of `in ($1..$n)` / drizzle `inArray`: the
 * statement text no longer depends on the list length (each length was one more prepared statement per connection, uncapped).
 * Elements are double-quoted (array literal syntax), so any text is safe.
 */
export const pgArray = (xs: readonly string[], type: 'uuid' | 'text') =>
  sql`${`{${xs.map((x) => `"${x.replace(/[\\"]/g, '\\$&')}"`).join(',')}}`}::${sql.raw(type)}[]`;
export const uuids = (xs: readonly string[]) => pgArray(xs, 'uuid');

/**
 * D-1104 (P-532): `q` inside an RLS transaction, as the connection's own role (what the server connection would do), without taking a
 * second pool connection while this one is held (10 such transactions waiting for an 11th connection = the pool stuck until the idle
 * timeout). Three statements in call order, one flight: role back to the login role, `q`, role `authenticated` again. If `q` fails
 * the transaction is aborted, so nothing runs with the wider role afterwards. Only for statements on tables `authenticated` has no
 * grant for, filtered by the transaction's user: writes, and the entitlements usage read (`referrals`, P-541 D-1114).
 */
export async function asServer<R>(tx: Tx, q: SQL): Promise<R[]> {
  const off = Promise.resolve(tx.execute(sql`select set_config('role', 'none', true)`));
  const out = Promise.resolve(tx.execute<R & Record<string, unknown>>(q));
  const on = Promise.resolve(tx.execute(sql`select set_config('role', 'authenticated', true)`));
  const [, rows] = await Promise.all([off, out, on]);
  return rows as R[];
}

/** Thrown inside a transaction to roll it back with a domain error. */
export class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}
/** SQLSTATE of a postgres-js error, also when Drizzle wraps it in `cause`. */
export const pgCode = (e: unknown): string | undefined => {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const c = x?.code ?? x?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
export const guard = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof Abort) return { ok: false, error: e.error };
    // RLS WITH CHECK (42501): the client's view is stale (e.g. an edge to a card another tab just deleted). A 409, not an opaque 500.
    if (pgCode(e) === '42501') return { ok: false, error: { code: 'conflict', message: 'stale_state' } };
    throw e;
  }
};
