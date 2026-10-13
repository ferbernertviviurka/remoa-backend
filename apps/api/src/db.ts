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
let databaseModule: Promise<typeof import('@remoa/db')> | undefined;
export const dbm = () => (databaseModule ??= import('@remoa/db'));

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
 * what they lack; a run() records successful uses but releases its connection immediately after its transaction ends.
 * No request waits on either. ponytail: one Describe round trip per statement and connection, in the background; process-wide caps;
 * pids of closed connections stay in `warmOn` (a handful per day).
 */
const WARM_PER_RUN = 4;
export const WARM_OPERATION_MS = 2_000;
let warming: Promise<void> | undefined;

/** A queued reserve cannot be cancelled by postgres.js. Release a late acquisition rather than orphaning it. */
async function reserveForWarm(c: Dbm['db']['$client'], signal?: AbortSignal): Promise<Reserved> {
  const pending = c.reserve();
  try { return await warmWait(pending, signal); }
  catch (e) { void pending.then((r) => r.release(), () => undefined); throw e; }
}

/** Bound only the queued acquisition; active driver queries keep their lease until they naturally settle. */
function warmWait<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn();
    };
    const abort = () => finish(() => {
      reject(new Error('database warm-up interrupted'));
    });
    const timer = setTimeout(abort, WARM_OPERATION_MS);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then((v) => finish(() => resolve(v)), (e: unknown) => finish(() => reject(e)));
    if (signal?.aborted) abort();
  });
}

async function warmConnection(r: Reserved, signal?: AbortSignal) {
  if (signal?.aborted) return;
  const q = r.unsafe('select 1');
  // postgres.js CancelRequest uses a separate socket and cancel() returns void. Do not release an active query
  // on an artificial deadline: a delayed cancel could hit the next user's query on that connection.
  await q;
  if (signal?.aborted) return;
  await shareStatements(r, (q as unknown as { state?: { pid?: number } }).state?.pid, new Set(), WARM_PER_RUN, signal);
}

function warmIdle(m: Dbm) {
  if (warming) return;
  // One finite pass: a stream of newly learned queries must never keep a connection in an endless replay loop.
  warming = (async () => {
    for (let i = 0; i < m.db.$client.options.max; i++) {
      const r = await reserveForWarm(m.db.$client);
      try { await warmConnection(r); }
      finally { r.release(); }
    }
  })().catch(() => undefined).finally(() => (warming = undefined));
}
const learned = new Map<string, { q: string; args: unknown[] }>();
const warmOn = new Map<number, Set<string>>(); // backend pid -> statements it has prepared
const shape = (x: unknown): unknown => (x instanceof Date ? new Date(0) : typeof x === 'boolean' ? false : typeof x === 'bigint' ? 0n
  : x instanceof Uint8Array ? new Uint8Array() : Array.isArray(x) ? [shape(x[0])] : null); // same inferred type, no user data kept
const kindOf = (x: unknown): string => (x instanceof Date ? 'd' : typeof x === 'boolean' ? 'b' : typeof x === 'bigint' ? 'n'
  : x instanceof Uint8Array ? 'u' : Array.isArray(x) ? `a${kindOf(x[0])}` : '0');
async function shareStatements(r: Reserved, pid: number | undefined, used: Set<string>, cap = WARM_PER_RUN, signal?: AbortSignal) {
  if (!pid) return;
  const have = warmOn.get(pid) ?? new Set<string>();
  warmOn.set(pid, have);
  for (const k of used) have.add(k);
  let n = 0;
  for (const [k, s] of learned) {
    if (n >= cap || signal?.aborted) break;
    if (have.has(k)) continue;
    n++;
    const query = r.unsafe(s.q, s.args as never[], { prepare: true });
    try {
      await query.describe();
      have.add(k); // a failed/aborted prepare remains eligible for a later finite pass
    } catch (e) {
      log().warn('database statement warm-up skipped', { error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
}
/**
 * D-1123: one bounded prepare pass per available connection. Each worker releases independently, including failure/abort.
 * Startup readiness does not promise all statements are prepared: ordinary requests can prepare cold statements themselves.
 */
export async function warmStatements(signal?: AbortSignal) {
  const c = (await dbm()).db.$client;
  // Each acquisition owns its release. Never wait for the entire pool to be held before releasing anything:
  // overlapping warmers can otherwise split the finite pool and wait forever for each other's reservations.
  for (let i = 0; i < c.options.max; i++) {
    if (signal?.aborted) return;
    const r = await reserveForWarm(c, signal);
    try { await warmConnection(r, signal); }
    finally { r.release(); }
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
    // Return request connections immediately after COMMIT/ROLLBACK. Speculative prepares run in their own finite pass.
    void ended.then(() => {
      const pid = (bq as { state?: { pid?: number } }).state?.pid;
      if (pid) {
        const have = warmOn.get(pid) ?? new Set<string>();
        for (const k of used) have.add(k);
        warmOn.set(pid, have);
      }
    }, () => undefined).finally(() => r.release());
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
 * D-1096: a finite best-effort pool acquisition pass at boot. Each lease returns before the next acquisition,
 * so normal traffic and jobs needing a nested connection can advance. The driver may reuse the same connection:
 * readiness promises availability, not that every pool member or learned statement is already warm.
 */
export async function warmPool(signal?: AbortSignal) {
  const c = (await dbm()).db.$client;
  for (let i = 0; i < c.options.max; i++) {
    if (signal?.aborted) return;
    const r = await reserveForWarm(c, signal);
    r.release();
  }
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
