import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { ok, type AppError, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { liveSessionSql, sessionGate, settleGate, type SessionRow } from './auth-session';

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
    set_config('statement_timeout', ${String(t.statementMs)}, true), set_config('idle_in_transaction_session_timeout', ${String(t.idleTxMs)}, true)`;
  if (!sessionId) return sql`select ${setup}`;
  return sql`select ${setup}, ls.live, ls.deleted_at, ls.suspended_at, ls.has_profile from (select 1) one left join (${liveSessionSql(userId, sessionId)}) ls on true`;
}

/** withUser() of @remoa/db plus FR-25 timeouts and the fused session check (D-990/D-991): BEGIN + 1 statement + COMMIT fixed. */
export const run = async <T>(userId: string, fn: (tx: Tx, s: typeof import('@remoa/db')) => Promise<T>) => {
  const m = await dbm();
  const g = sessionGate.getStore();
  const owed = g && g.state !== 'ok' && g.userId === userId ? g : undefined;
  return m.db.transaction(async (tx) => {
    const [r] = await tx.execute<SessionRow>(firstStatement(userId, currentTimeouts(), owed?.state === 'pending' ? owed.sessionId : undefined));
    if (owed) settleGate(owed, owed.state === 'pending' ? r : undefined); // throws SessionRejected → rollback, nothing of fn runs
    return fn(tx, m);
  });
};

/** Thrown inside a transaction to roll it back with a domain error. */
export class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}
export const guard = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof Abort) return { ok: false, error: e.error };
    throw e;
  }
};
