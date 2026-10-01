import { sql } from 'drizzle-orm';
import { err, ok, type AssertQuota } from '@remoa/contracts';
import { dbm, run } from '../db';
import { dayWindow } from '../review/queue';

/** D-062 interim (until F08): free-tier AI gradings per local study day. */
export const AI_GRADES_PER_DAY = 20;

/** Local study day (profile timezone, 04:00 rollover) used as `usage_counters.period`. */
export const localDay = (userId: string, now: Date) => run(userId, async (tx) => (await dayWindow(tx, userId, now)).day);

/**
 * AssertQuota-shaped. Checks AND consumes one unit of `ai_grades` atomically (the caller invokes it right before
 * calling the grader). F08 replaces this with entitlements-based limits; the call site stays the same.
 * Written with the server connection: `authenticated` cannot write usage_counters.
 */
export const assertQuota = async (userId: string, key: 'ai_grades' = 'ai_grades', now = new Date()): ReturnType<AssertQuota> => {
  const period = await localDay(userId, now);
  const { db } = await dbm();
  const rows = await db.execute(sql`
    insert into usage_counters (user_id, period, ai_grades) values (${userId}, ${period}::date, 1)
    on conflict (user_id, period) do update set ai_grades = usage_counters.ai_grades + 1, updated_at = now()
      where usage_counters.ai_grades < ${AI_GRADES_PER_DAY}
    returning ai_grades`);
  return rows.length ? ok(null) : err('quota_exceeded', `${key} daily limit reached`);
};

/** Gives back the unit when the grader failed (timeout/error): the student got no correction. */
export const refundQuota = async (userId: string, now = new Date()) => {
  const period = await localDay(userId, now);
  const { db } = await dbm();
  await db.execute(sql`update usage_counters set ai_grades = ai_grades - 1 where user_id = ${userId} and period = ${period}::date and ai_grades > 0`);
};
