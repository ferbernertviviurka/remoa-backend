import { eq } from 'drizzle-orm';
import { err, ok, type CheckoutInput, type PortalInput, type RedirectUrl, type Result } from '@remoa/contracts';
import { dbm } from '../db';
import type { StripePort } from './stripe';

/** D-100: the only accepted coupon is FUNDADOR (mapped to STRIPE_COUPON_FUNDADOR). */
export const createCheckout = (stripe: StripePort) => async (userId: string, input: CheckoutInput): Promise<Result<RedirectUrl>> => {
  if (input.coupon && input.coupon.toUpperCase() !== 'FUNDADOR') return err('validation', 'invalid coupon');
  const { db, subscriptions } = await dbm();
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  // A second checkout over a live card subscription would orphan it (still charging, invisible to portal and deleteAccount).
  if (row?.stripeSubscriptionId && row.plan === 'pro' && row.status !== 'canceled' && !row.cancelAtPeriodEnd) return err('conflict', 'already subscribed');
  let customerId = row?.stripeCustomerId;
  if (!customerId) {
    customerId = await stripe.createCustomer(userId);
    await db.insert(subscriptions).values({ userId, stripeCustomerId: customerId }).onConflictDoUpdate({ target: subscriptions.userId, set: { stripeCustomerId: customerId } });
  }
  return ok({ url: await stripe.checkout({ userId, customerId, period: input.period, method: input.method, fundador: !!input.coupon }) });
};

export const openPortal = (stripe: StripePort) => async (userId: string, input: PortalInput): Promise<Result<RedirectUrl>> => {
  const { db, subscriptions } = await dbm();
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!row?.stripeCustomerId) return err('not_found', 'no billing account');
  return ok({ url: await stripe.portal({ userId, customerId: row.stripeCustomerId, subscriptionId: row.stripeSubscriptionId, cancel: !!input.cancel }) });
};
