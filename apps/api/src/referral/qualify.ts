// F18 FR-17/FR-18 (D-384): synchronous, idempotent qualification. Called after every write that can create cards.
import { sql } from 'drizzle-orm';
import { REFERRAL_LIMITS } from '@remoa/contracts';
import { createLogger, type Logger } from '@remoa/log';
import { applyPendingCredits } from '../billing/credits';
import { dbm } from '../db';
import { rejectReason } from './fraud';
import { grantBothSides, type GrantFn } from './grant';
import { notifyRewardGranted } from './notify';
import { invalidate } from '../cache';

export type QualifyOutcome = 'none' | 'pending' | 'qualified' | 'rejected';

const fallbackLog = createLogger({ requestId: 'referral-qualify' });

/**
 * Never throws (a card write must not fail because of the referral): errors are logged and the daily sweep retries.
 * Cheap exit when the user was not referred. Row lock (`for update`) + status guard = two concurrent calls grant once.
 */
export async function maybeQualifyReferral(
  userId: string,
  o: { now?: Date; log?: Logger; grant?: GrantFn } = {},
): Promise<QualifyOutcome> {
  const log = o.log ?? fallbackLog;
  const now = o.now ?? new Date();
  try {
    const { db } = await dbm();
    const [p] = await db.execute<{ referred_by: string | null }>(sql`select referred_by from profiles where user_id = ${userId}`);
    if (!p?.referred_by) return 'none';

    const res = await db.transaction(async (tx) => {
      const [r] = await tx.execute<{ id: string; referrer_id: string; status: string }>(
        sql`select id, referrer_id, status from referrals where referee_id = ${userId} for update`,
      );
      if (!r || r.status !== 'signed_up') return { outcome: 'none' as const };
      const [ok] = await tx.execute<{ ok: boolean }>(sql`
        select (select email_confirmed_at is not null from auth.users where id = ${userId})
          and exists (
            select 1 from boards b where b.user_id = ${userId} and b.archived_at is null
              and (select count(*) from cards c where c.board_id = b.id and c.deleted_at is null) >= ${REFERRAL_LIMITS.qualifyMinCards}
          ) as ok`);
      if (!ok?.ok) return { outcome: 'pending' as const };

      // serializes every qualification of this referrer, so the 30-day count below is exact
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'referral-velocity:' + r.referrer_id}))`);
      const emails = await tx.execute<{ id: string; email: string | null }>(sql`select id, email from auth.users where id in (${r.referrer_id}, ${userId})`);
      const email = (id: string) => emails.find((e) => e.id === id)?.email ?? null;
      const reason = await rejectReason(tx, { referrerId: r.referrer_id, refereeId: userId, referrerEmail: email(r.referrer_id), refereeEmail: email(userId) }, now);
      if (reason) {
        await tx.execute(sql`update referrals set status = 'rejected', reject_reason = ${reason} where id = ${r.id}`);
        return { outcome: 'rejected' as const, reason, referrerId: r.referrer_id };
      }
      await tx.execute(sql`update referrals set status = 'qualified', qualified_at = ${now.toISOString()} where id = ${r.id}`);
      const granted = await grantBothSides(tx, { id: r.id, referrerId: r.referrer_id, refereeId: userId }, o.grant);
      return { outcome: 'qualified' as const, id: r.id, granted, referrerId: r.referrer_id };
    });

    if (res.outcome === 'qualified' || res.outcome === 'rejected') {
      // after COMMIT: both sides' referral summary and (qualified) entitlements
      for (const id of [res.referrerId, userId]) await invalidate('referral.changed', { userId: id });
    }
    if (res.outcome === 'rejected') {
      log.warn('referral_rejected', { event: 'referral_rejected', reason: res.reason });
    }
    if (res.outcome === 'qualified') {
      log.info('first_board_created', { event: 'first_board_created' });
      log.info('referral_qualified', { event: 'referral_qualified' });
      for (const g of res.granted) {
        log.info('referral_reward_granted', { event: 'referral_reward_granted', side: g.side, kind: g.kind });
      }
      // FR-19: Stripe only after commit; a failure leaves the credit pending for the sweep
      for (const g of res.granted) if (g.kind === 'credit') await applyPendingCredits(g.userId).catch(() => null);
      await notifyRewardGranted(res.id); // never throws
    }
    return res.outcome;
  } catch (e) {
    log.error('referral qualify failed', { error: e instanceof Error ? e.message : String(e) }); // retried by sweepReferrals
    return 'pending';
  }
}
