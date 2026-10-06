// F15 planos e checkout: price book, coupon, return check, subscription summary, switch to annual (D-188–D-192).
import { eq } from 'drizzle-orm';
import { pick } from '../pick';
import { createLogger } from '@remoa/log';
import { err, nextChargeDate, ok, type CheckoutSessionStatus, type CouponValidation, type PriceBook, type Result, type SubscriptionSummary, type SwitchToAnnualResult } from '@remoa/contracts';
import { dbm, run } from '../db';
import { dayWindow } from '../review/queue';
import { cachedPrices, checkedPromotion, createCheckout, DOUBLE_CLICK_MS, once, pricesFetchedAt } from './checkout';
import { paidPlanOf } from './plan';
import { discounted, plansPort, type SessionInfo, type StripePort } from './stripe';

const off = () => err('internal', 'billing unavailable');
const rowOf = async (userId: string) => {
  const { db, subscriptions } = await dbm();
  return (await db.select(pick(subscriptions, 'plan', 'status', 'stripeCustomerId', 'stripeSubscriptionId', 'renewsAt', 'cancelAtPeriodEnd')).from(subscriptions).where(eq(subscriptions.userId, userId)))[0];
};

/** FR-5/FR-6: Stripe prices (cached) + "Próxima cobrança" in the profile timezone. */
export const getPriceBook = (stripe?: StripePort) => async (userId: string, now = new Date()): Promise<Result<PriceBook>> => {
  const plans = plansPort(stripe);
  if (!plans) return off();
  const [book, { tz }] = await Promise.all([cachedPrices(plans), run(userId, (tx) => dayWindow(tx, userId, now))]);
  return ok({
    monthly: { ...book.monthly, currency: 'brl' },
    annual: { ...book.annual, currency: 'brl' },
    lifetime: { ...book.lifetime, currency: 'brl' },
    nextChargeOn: { monthly: nextChargeDate('monthly', now, tz), annual: nextChargeDate('annual', now, tz) },
    fetchedAt: pricesFetchedAt(plans),
  });
};

/** D-185/D-189: `{ valid: false }` for anything unusable (never why); wrong guesses are rate-limited. */
export const validateCoupon = (stripe?: StripePort) => async (userId: string, code: string): Promise<Result<CouponValidation>> => {
  const plans = plansPort(stripe);
  if (!plans) return off();
  const promo = await checkedPromotion(plans, userId, code, (await rowOf(userId))?.stripeCustomerId ?? null);
  if (promo === 'rate_limited') return err('rate_limited', 'too many coupon attempts');
  if (!promo) return ok({ valid: false });
  const book = await cachedPrices(plans);
  return ok({ valid: true, kind: promo.percentOff != null ? 'percent' : 'amount', monthly: discounted(book.monthly.amount, promo), annual: discounted(book.annual.amount, promo) });
};

/** D-186. `paid` is what Stripe says about the payment; entitlements only change through the webhook (D-181). */
export const sessionOutcome = (s: Pick<SessionInfo, 'status' | 'paymentStatus'>): CheckoutSessionStatus['status'] =>
  s.status === 'expired' ? 'expired' : s.status !== 'complete' ? 'canceled' : s.paymentStatus === 'unpaid' ? 'pending_pix' : 'paid';

/** FR-8: the return page asks the server; another student's (or an unknown) session is `not_found`, same answer for both. */
export const getCheckoutSession = (stripe?: StripePort) => async (userId: string, sessionId: string): Promise<Result<CheckoutSessionStatus>> => {
  const plans = plansPort(stripe);
  if (!plans) return off();
  const s = await plans.session(sessionId);
  if (!s || s.userId !== userId) return err('not_found', 'checkout session not found');
  return ok({ status: sessionOutcome(s), plan: s.period === 'lifetime' ? 'founder' : 'pro', period: s.period, method: s.method });
};

/** FR-9: null without a paid period. Period/amount come from Stripe (the table stores neither). Founder: its one-time payment, `period: 'lifetime'` (D-375). */
export const getSubscription = (stripe?: StripePort) => async (userId: string, now = new Date()): Promise<Result<SubscriptionSummary | null>> => {
  const plans = plansPort(stripe);
  if (!plans) return off();
  const [p, row] = await Promise.all([paidPlanOf(userId, now), rowOf(userId)]);
  if (p.plan === 'free' || !row?.stripeCustomerId) return ok(null);
  const card = row.stripeSubscriptionId;
  const detail = card ? await plans.plan(card) : await plans.lastPayment(row.stripeCustomerId);
  if (!detail) {
    // Pro without any Stripe payment (granted by hand): nothing true to show.
    createLogger({ requestId: userId }).warn('pro without a stripe payment', { userId });
    return ok(null);
  }
  return ok({
    status: p.status, renewsAt: p.renewsAt, cancelAtPeriodEnd: p.cancelAtPeriodEnd, graceUntil: p.graceUntil,
    period: p.plan === 'founder' ? 'lifetime' : detail.period, method: card ? 'card' : ('method' in detail && detail.method) || 'pix', amount: detail.amount, pastDue: p.status === 'past_due',
  });
};

/** FR-9 / D-190: card monthly → Stripe prorates in place; Pix monthly → checkout for an annual Pix (extends the paid period). */
export const switchToAnnual = (stripe?: StripePort) => async (userId: string, now = new Date()): Promise<Result<SwitchToAnnualResult>> => {
  const plans = plansPort(stripe);
  if (!plans || !stripe) return off();
  const [p, row] = await Promise.all([paidPlanOf(userId, now), rowOf(userId)]);
  const notMonthly = () => err<SwitchToAnnualResult>('conflict', 'not on a monthly Pro plan');
  if (p.plan !== 'pro' || !row?.stripeCustomerId) return notMonthly();
  const subId = row.stripeSubscriptionId;
  if (!subId) {
    if ((await plans.lastPayment(row.stripeCustomerId))?.period !== 'monthly') return notMonthly();
    const r = await createCheckout(stripe)(userId, { period: 'annual', method: 'pix' });
    return r.ok ? ok({ kind: 'redirect', url: r.data.url }) : r;
  }
  // Scheduled cancel or failed payment: the student fixes that first (reactivate / update card), not an immediate annual charge.
  if (p.cancelAtPeriodEnd || (p.status !== 'active' && p.status !== 'trialing')) return notMonthly();
  const customerId = row.stripeCustomerId;
  return once(`switch:${userId}`, async () => {
    const d = await plans.plan(subId);
    if (d.period !== 'monthly') return notMonthly();
    return ok(await plans.switchAnnual({ customerId, subscriptionId: subId, itemId: d.itemId, idempotencyKey: `switch:${subId}:${d.itemId}:${Math.floor(Date.now() / DOUBLE_CLICK_MS)}` }));
  });
};
