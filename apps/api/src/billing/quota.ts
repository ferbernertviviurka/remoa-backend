import { sql } from 'drizzle-orm';
import { err, ok, PLAN_LIMITS, planDefinition, type AiQuota, type AppError, type AssertQuota, type QuotaKey } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { asServer, dbm } from '../db';
import { planOf } from './plan';

const DEFAULT_TZ = 'America/Sao_Paulo';
/** G22 (D-1411): AI quotas turn over at midnight of the profile timezone (the calendar day), not at the 04:00 study-day rollover. */
export const daySql = (userId: string, now: Date) =>
  sql`(${now.toISOString()}::timestamptz at time zone coalesce((select timezone from profiles where user_id = ${userId}), ${DEFAULT_TZ}::text))::date`;

/** Local calendar day (profile timezone, midnight rollover) used as `usage_counters.period` of the AI counters. */
export const localDay = async (userId: string, now: Date) => {
  const { db } = await dbm();
  const [r] = await db.execute<{ day: string }>(sql`select ${daySql(userId, now)}::text as day`);
  return r!.day;
};

export type AiKey = AiQuota['key'];
// column = fixed identifier (never user input)
const COUNTER: Record<AiKey, { col: ReturnType<typeof sql.identifier>; period: (day: ReturnType<typeof sql>) => ReturnType<typeof sql> }> = {
  ai_grades: { col: sql.identifier('ai_grades'), period: (d) => d }, // per local day
  ai_rubrics: { col: sql.identifier('ai_rubrics'), period: (d) => d }, // per local day (D-1412)
  ai_generations: { col: sql.identifier('ai_generations'), period: (d) => sql`date_trunc('month', ${d})::date` }, // per calendar month
};

/** D-167: one rule for display and blocking: live cards of non-archived boards. */
export const liveCardsSql = (userId: string) =>
  sql`select count(*)::int from cards c join boards b on b.id = c.board_id where b.user_id = ${userId} and b.archived_at is null and c.deleted_at is null`;

/** Live totals. `exec` = the caller's tx (sees its own uncommitted rows) or the server connection. */
export async function overTotal(exec: Pick<Tx, 'execute'>, userId: string, key: 'boards' | 'cards', limit: number | null, add = 1) {
  if (limit === null) return false;
  const [r] = await exec.execute<{ n: number }>(
    key === 'boards'
      ? sql`select count(*)::int as n from boards where user_id = ${userId} and archived_at is null`
      : sql`select (${liveCardsSql(userId)}) as n`,
  );
  return r!.n + add > limit;
}

/** Plan limit of one key (null = unlimited), from PlanDefinition. ai_rubrics = the plan's ai_grades number on its own counter (D-1412). */
export const limitFor = async (userId: string, key: QuotaKey | 'ai_rubrics', now = new Date(), tx?: Tx) =>
  planDefinition((await planOf(userId, now, tx)).plan)[key === 'ai_rubrics' ? 'ai_grades' : key];

export const quotaView = (key: AiKey, used: number, limit: number | null, period: string): AiQuota => ({
  key, used, limit, period, remaining: limit === null ? null : Math.max(0, limit - used), nearLimit: limit !== null && limit > 0 && used >= Math.ceil(limit * 0.8),
});

export type Reservation = { ok: true; readonly quota: AiQuota; refund: (tx?: Tx) => Promise<AiQuota> };

/**
 * G22 (D-1411): takes one unit BEFORE the AI call, atomically (`on conflict do update ... where used < limit`: N concurrent calls on
 * the last unit, exactly one row comes back). The caller gives it back with `refund()` on any failure or offline fallback, so only
 * a successful AI answer stays counted. `refund()` hits the same period (a call that crosses midnight refunds the day it was taken)
 * and runs at most once. Unlimited plans still count. Server role: `authenticated` cannot write usage_counters.
 * D-1104 (P-532): with `tx` (the caller's run()), the unit is taken inside that transaction (asServer), never on a second pool
 * connection while `tx` holds one; a rollback then gives it back by itself, so such a caller must not refund after a rollback.
 * `refund(tx)` the same, inside a transaction that also took the unit; `refund()` on the server connection, after its commit.
 */
export async function reserveAi(userId: string, key: AiKey, now = new Date(), tx?: Tx): Promise<Reservation | { ok: false; error: AppError }> {
  const limit = await limitFor(userId, key, now, tx);
  const { col, period } = COUNTER[key];
  if (limit === 0) return { ok: false, error: { code: 'quota_exceeded', message: key } }; // D-647: Free has no PDF maps
  const cap = limit === null ? sql`` : sql`where usage_counters.${col} < ${limit}`;
  const q = sql`
    insert into usage_counters (user_id, period, ${col}) values (${userId}, ${period(daySql(userId, now))}, 1)
    on conflict (user_id, period) do update set ${col} = usage_counters.${col} + 1, updated_at = now() ${cap}
    returning period::text as period, ${col} as used`;
  const [row] = tx ? await asServer<{ period: string; used: number }>(tx, q) : await (await dbm()).db.execute<{ period: string; used: number }>(q);
  if (!row) return { ok: false, error: { code: 'quota_exceeded', message: key } };
  let quota = quotaView(key, row.used, limit, row.period);
  let done = false;
  return {
    ok: true,
    get quota() {
      return quota;
    },
    refund: async (inTx?: Tx) => {
      if (done) return quota;
      done = true;
      await refundAt(userId, key, row.period, inTx);
      quota = quotaView(key, Math.max(0, quota.used - 1), limit, row.period);
      return quota;
    },
  };
}

/** Gives one unit back on the exact period it was taken from (never below zero). */
export async function refundAt(userId: string, key: AiKey, period: string, tx?: Tx) {
  const { col } = COUNTER[key];
  const q = sql`update usage_counters set ${col} = ${col} - 1, updated_at = now() where user_id = ${userId} and period = ${period}::date and ${col} > 0`;
  if (tx) await asServer(tx, q);
  else await (await dbm()).db.execute(q);
}

/**
 * AssertQuota-shaped. ai_grades/ai_generations: reserves one unit (see reserveAi; the refund handle is dropped, so only callers
 * that never fail after it should use this). boards/cards: only checks the live total (creation is the caller's job).
 * Failure message is exactly the key (D-101: the frontend maps it to the paywall reason).
 * ponytail: boards/cards check-then-insert is not serialized across concurrent requests; a lock per user if abuse shows up.
 */
export const assertQuota = async (userId: string, key: QuotaKey, now = new Date()): ReturnType<AssertQuota> => {
  if (key === 'boards' || key === 'cards') {
    const { db } = await dbm();
    return (await overTotal(db, userId, key, await limitFor(userId, key, now))) ? err('quota_exceeded', key) : ok(null);
  }
  const r = await reserveAi(userId, key, now);
  return r.ok ? ok(null) : { ok: false, error: r.error };
};

/** D-648: completed Anki imports of the account (lifetime); failed/canceled ones do not count. */
export async function overAnkiImports(userId: string, now = new Date()) {
  const cap = PLAN_LIMITS[(await planOf(userId, now)).plan].ankiImports;
  if (cap === null) return false;
  const { db } = await dbm();
  const [r] = await db.execute<{ n: number }>(sql`select count(*)::int as n from imports where user_id = ${userId} and kind = 'anki' and status = 'done'`);
  return r!.n >= cap;
}
