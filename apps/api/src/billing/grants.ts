// F18 FR-18/FR-19 (D-381, D-408–D-410): the referral month, as Pro time (grant) or as Stripe balance credit.
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { dbm } from '../db';
import { subscriptionPro } from './plan';
import { installedStripe, plansPort, type StripePort } from './stripe';

type Grant = typeof import('@remoa/db').entitlementGrants.$inferSelect;
type Credit = typeof import('@remoa/db').billingCredits.$inferSelect;
export type ReferralReward = { kind: 'month'; created: boolean; grant: Grant } | { kind: 'credit'; created: boolean; credit: Credit };

/** Serializes every grant/credit write of one user (chain math, webhook conversion). Released at commit. */
export const lockGrants = (tx: Tx, userId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`grant:${userId}`}))`);

/** Price of one month of the subscriber's plan, what they actually pay (coupon included); annual = 1/12, rounded to the centavo. */
export async function monthCents(stripe: StripePort | undefined, subscriptionId: string) {
  const plans = plansPort(stripe);
  if (!plans) throw new Error('billing unavailable: cannot price the referral credit');
  const d = await plans.plan(subscriptionId);
  return d.period === 'annual' ? Math.round(d.amount / 12) : d.amount;
}

/**
 * One referral month for `userId`, inside the caller's transaction (server connection; T2's qualification).
 * - Card subscription that will renew → `billing_credits` row (pending; call `applyPendingCredits(userId)` AFTER commit).
 * - Otherwise → `entitlement_grants`, chained: starts_at = greatest(now, end of the paid period when Pro is paid but won't
 *   renew, max ends_at of non-revoked grants); ends_at = starts_at + 1 calendar month.
 * Idempotent per (referral, user): a second call returns what the first created (`created: false`).
 * Throws (rolling the caller back, the sweep retries) only when a credit is due and Stripe can't price it.
 */
export async function grantReferralMonth(
  tx: Tx,
  { userId, referralId, now = new Date(), stripe = installedStripe() }: { userId: string; referralId: string; now?: Date; stripe?: StripePort },
): Promise<ReferralReward> {
  const { entitlementGrants: g, billingCredits: c, subscriptions: s } = await dbm();
  await lockGrants(tx, userId);
  const [grant] = await tx.select().from(g).where(and(eq(g.referralId, referralId), eq(g.userId, userId)));
  if (grant) return { kind: 'month', created: false, grant };
  const [credit] = await tx.select().from(c).where(and(eq(c.referralId, referralId), eq(c.userId, userId)));
  if (credit) return { kind: 'credit', created: false, credit };

  const [sub] = await tx.select().from(s).where(eq(s.userId, userId));
  const paid = subscriptionPro(sub, now);
  if (paid.pro && sub!.stripeSubscriptionId && !sub!.cancelAtPeriodEnd) {
    const amountCents = await monthCents(stripe, sub!.stripeSubscriptionId);
    if (amountCents > 0) {
      const [row] = await tx.insert(c).values({ userId, referralId, amountCents }).onConflictDoNothing().returning();
      return { kind: 'credit', created: true, credit: row! };
    }
  }
  const paidUntil = paid.pro ? (paid.graceUntil ?? sub!.renewsAt) : null;
  const at = now.toISOString();
  const [r] = await tx.execute<{ start: string }>(sql`
    select greatest(${at}::timestamptz, ${paidUntil?.toISOString() ?? null}::timestamptz,
      (select max(ends_at) from ${g} where user_id = ${userId} and revoked_at is null)) as start`);
  const from = new Date(r!.start); // raw execute may hand back a string or a Date
  const [row] = await tx
    .insert(g)
    .values({ userId, referralId, source: 'referral', startsAt: from, endsAt: sql`${from.toISOString()}::timestamptz + interval '1 month'` })
    .onConflictDoNothing()
    .returning();
  return { kind: 'month', created: true, grant: row! };
}

/**
 * FR-19 "quem assina durante um período grátis": on a new card subscription, every referral grant not yet over is revoked
 * (`converted`, CCR-012/D-470; promo/support grants are left alone, no credit) and its unused share becomes credit: future grants a full month, the running one prorated by time left.
 * Same transaction as the subscription write (webhook); apply the credits after commit.
 */
export async function convertGrantsToCredits(tx: Tx, userId: string, perMonthCents: number, now = new Date()) {
  const { entitlementGrants: g, billingCredits: c } = await dbm();
  await lockGrants(tx, userId);
  const gone = await tx
    .update(g)
    .set({ revokedAt: now, revokedReason: 'converted' })
    .where(and(eq(g.userId, userId), eq(g.source, 'referral'), isNull(g.revokedAt), gt(g.endsAt, now)))
    .returning();
  const left = (x: Grant) => {
    const from = Math.max(x.startsAt.getTime(), now.getTime());
    return Math.round((perMonthCents * (x.endsAt.getTime() - from)) / (x.endsAt.getTime() - x.startsAt.getTime()));
  };
  const rows = gone.map((x) => ({ userId, referralId: x.referralId, amountCents: left(x) })).filter((x) => x.amountCents > 0);
  if (rows.length) await tx.insert(c).values(rows).onConflictDoNothing();
  return rows.length;
}
