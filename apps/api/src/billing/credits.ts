// F18 FR-19 (D-384, D-411): push pending `billing_credits` to the Stripe customer balance. Never inside a transaction.
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { installedStripe, type StripePort } from './stripe';

/**
 * Applies pending credits of one user (after the qualification/webhook commit) or of everyone (`userId` omitted: T2's daily sweep).
 * Idempotency key `referral-credit:<credit id>`: a retry (or a race with the sweep) reuses the same Stripe transaction.
 * Success fills `stripe_balance_txn_id` and `applied_at` together; any failure leaves the row pending for the next sweep.
 * ponytail: Stripe keeps idempotency keys 24 h; a txn created at Stripe whose DB write then failed for > 24 h would be credited
 * twice. Search balance txns by `metadata.idempotencyKey` before creating if that ever shows up in the logs.
 */
export async function applyPendingCredits(userId?: string, stripe: StripePort | undefined = installedStripe()) {
  const log = createLogger({ requestId: `credits:${userId ?? 'sweep'}` });
  const { db, billingCredits: c, subscriptions: s, referrals: r } = await dbm();
  const rows = await db
    .select({ id: c.id, userId: c.userId, amountCents: c.amountCents, customerId: s.stripeCustomerId })
    .from(c)
    .leftJoin(s, eq(s.userId, c.userId))
    .leftJoin(r, eq(r.id, c.referralId))
    // D-399: a referral rejected after the credit was created (manual review, F19) never reaches Stripe
    .where(and(isNull(c.appliedAt), userId ? eq(c.userId, userId) : undefined, or(isNull(r.status), ne(r.status, 'rejected'))));
  let applied = 0;
  for (const r of rows) {
    if (!stripe?.createBalanceTransaction || !r.customerId) {
      log.warn('referral credit left pending', { creditId: r.id, reason: r.customerId ? 'stripe unavailable' : 'no stripe customer' });
      continue;
    }
    try {
      const txn = await stripe.createBalanceTransaction({ customerId: r.customerId, amountCents: r.amountCents, idempotencyKey: `referral-credit:${r.id}`, description: 'Remoa: indicação de amigo (1 mês)' });
      await db.update(c).set({ stripeBalanceTxnId: txn, appliedAt: new Date() }).where(and(eq(c.id, r.id), isNull(c.appliedAt)));
      applied++;
      log.info('referral credit applied', { creditId: r.id, userId: r.userId, amountCents: r.amountCents });
    } catch (e) {
      log.warn('referral credit left pending', { creditId: r.id, reason: String(e) });
    }
  }
  return { applied, pending: rows.length - applied };
}
