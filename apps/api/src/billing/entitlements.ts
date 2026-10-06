import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { ok, PLAN_LIMITS, type GetEntitlements } from '@remoa/contracts';
import type { Env } from '../app';
import { dbm } from '../db';
import { ownTotals } from '../review/stats';
import { planOf } from './plan';
import { localDay } from './quota';

/** F08: plan, limits and current usage. Counters/totals are read with the server connection, always filtered by user. */
export const getEntitlements = async (userId: string, now = new Date()): ReturnType<GetEntitlements> => {
  const [p, day, { db }, totals] = await Promise.all([planOf(userId, now), localDay(userId, now), dbm(), ownTotals(userId, now)]);
  const [u] = await db.execute<{ ai_grades: number; ai_generations: number; boards: number; anki_imports_used: number; referral_pending: boolean }>(sql`
    select
      (select coalesce(sum(ai_grades), 0)::int from usage_counters where user_id = ${userId} and period = ${day}::date) as ai_grades,
      (select coalesce(sum(ai_generations), 0)::int from usage_counters where user_id = ${userId}
        and period >= date_trunc('month', ${day}::date) and period < date_trunc('month', ${day}::date) + interval '1 month') as ai_generations,
      (select count(*)::int from boards where user_id = ${userId} and archived_at is null) as boards,
      (select count(*)::int from imports where user_id = ${userId} and kind = 'anki' and status = 'done') as anki_imports_used,
      exists (select 1 from referrals where referrer_id = ${userId} and status in ('invited', 'signed_up')) as referral_pending`);
  const { limits, newCardsPerDay, ankiImportMaxCards, ankiImports } = PLAN_LIMITS[p.plan];
  const { referral_pending: referralPending, anki_imports_used: ankiImportsUsed, ...rest } = u!;
  const usage = { ...rest, cards: totals.cards + totals.notes }; // D-167 rule (live cards of non-archived own boards, notes included), from map_stats (G21 FR-23)
  return ok({ ...p, limits, usage, newCardsPerDay, ankiImportMaxCards, ankiImports, ankiImportsUsed, referralPending });
};

const memo = new WeakMap<Request, ReturnType<GetEntitlements>>();
/** Per-request cache: several guards in one request pay for one read. */
export const entitlementsOf = (c: Context<Env>) => {
  const hit = memo.get(c.req.raw);
  if (hit) return hit;
  const p = getEntitlements(c.get('userId'));
  memo.set(c.req.raw, p);
  return p;
};
