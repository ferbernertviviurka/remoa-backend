import { sql } from 'drizzle-orm';
import { err, ok, PLAN_LIMITS, type AssertQuota, type QuotaKey } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm, run } from '../db';
import { dayWindow } from '../review/queue';
import { planOf } from './plan';

/** Local study day (profile timezone, 04:00 rollover) used as `usage_counters.period`. */
export const localDay = (userId: string, now: Date) => run(userId, async (tx) => (await dayWindow(tx, userId, now)).day);

// column = fixed identifier (never user input)
const COUNTER = {
  ai_grades: { col: sql.identifier('ai_grades'), period: (d: string) => sql`${d}::date` }, // per local study day
  ai_generations: { col: sql.identifier('ai_generations'), period: (d: string) => sql`date_trunc('month', ${d}::date)::date` }, // per calendar month
} as const;

/** Live totals. `exec` = the caller's tx (sees its own uncommitted rows) or the server connection. */
export async function overTotal(exec: Pick<Tx, 'execute'>, userId: string, key: 'boards' | 'cards', limit: number | null, add = 1) {
  if (limit === null) return false;
  const [r] = await exec.execute<{ n: number }>(
    key === 'boards'
      ? sql`select count(*)::int as n from boards where user_id = ${userId} and archived_at is null`
      : sql`select count(*)::int as n from cards c join boards b on b.id = c.board_id where b.user_id = ${userId} and c.deleted_at is null`,
  );
  return r!.n + add > limit;
}

/** Plan limit of one key (null = unlimited). */
export const limitFor = async (userId: string, key: QuotaKey, now = new Date()) => PLAN_LIMITS[(await planOf(userId, now)).plan].limits[key];

/**
 * AssertQuota-shaped. ai_grades/ai_generations: checks AND consumes one unit atomically (call right before the AI call);
 * unlimited still counts. boards/cards: only checks the live total (creation is the caller's job).
 * Failure message is exactly the key (D-101: the frontend maps it to the paywall reason).
 * Written with the server connection: `authenticated` cannot write usage_counters.
 * ponytail: boards/cards check-then-insert is not serialized across concurrent requests; a lock per user if abuse shows up.
 */
export const assertQuota = async (userId: string, key: QuotaKey, now = new Date()): ReturnType<AssertQuota> => {
  const limit = await limitFor(userId, key, now);
  const { db } = await dbm();
  if (key === 'boards' || key === 'cards') return (await overTotal(db, userId, key, limit)) ? err('quota_exceeded', key) : ok(null);
  const { col, period } = COUNTER[key];
  const cap = limit === null ? sql`` : sql`where usage_counters.${col} < ${limit}`;
  const rows = await db.execute(sql`
    insert into usage_counters (user_id, period, ${col}) values (${userId}, ${period(await localDay(userId, now))}, 1)
    on conflict (user_id, period) do update set ${col} = usage_counters.${col} + 1, updated_at = now() ${cap}
    returning 1`);
  return rows.length ? ok(null) : err('quota_exceeded', key);
};

/** Gives back the unit when the grader failed (timeout/error): the student got no correction. */
export const refundQuota = async (userId: string, now = new Date()) => {
  const period = await localDay(userId, now);
  const { db } = await dbm();
  await db.execute(sql`update usage_counters set ai_grades = ai_grades - 1 where user_id = ${userId} and period = ${period}::date and ai_grades > 0`);
};
