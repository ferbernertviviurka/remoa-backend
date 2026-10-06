import { eq } from 'drizzle-orm';
import { pick } from '../pick';
import { couponCodeSchema, err, ok, type CheckoutInput, type PortalInput, type RedirectUrl, type Result } from '@remoa/contracts';
import { dbm } from '../db';
import { plansPort, type PlansPort, type PriceList, type Promo, type StripePort } from './stripe';

// --- F15 helpers (D-188, D-189) ----------------------------------------------------------------

/** Double-click window: same key inside it = same result, and the same Stripe idempotency key. */
export const DOUBLE_CLICK_MS = 10_000;
const inflight = new Map<string, { exp: number; p: Promise<unknown> }>();
/**
 * Coalesce identical calls (in flight or finished ok within `DOUBLE_CLICK_MS`). Failures are dropped so "Tentar de novo" works.
 * ponytail: per process; across instances the Stripe idempotency key built from the same window covers it.
 */
export function once<T>(key: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  const now = Date.now();
  for (const [k, v] of inflight) if (v.exp <= now) inflight.delete(k);
  const hit = inflight.get(key);
  if (hit) return hit.p as Promise<Result<T>>;
  const p = fn();
  const entry = { exp: now + DOUBLE_CLICK_MS, p };
  const drop = () => inflight.get(key) === entry && inflight.delete(key);
  inflight.set(key, entry);
  p.then((r) => !r.ok && drop(), drop);
  return p;
}

/** FR-5: Stripe Prices, cached per port. ponytail: in-process 10 min TTL; a Price edited in Stripe shows (and charges Pix) up to 10 min late; invalidate on `price.updated` if that matters. */
export const PRICE_TTL_MS = 10 * 60_000;
const priceCache = new WeakMap<object, { at: number; p: Promise<PriceList> }>();
export const cachedPrices = (port: PlansPort): Promise<PriceList> => {
  const hit = priceCache.get(port);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.p;
  const entry = { at: Date.now(), p: port.prices() };
  priceCache.set(port, entry);
  entry.p.catch(() => priceCache.get(port) === entry && priceCache.delete(port));
  return entry.p;
};
export const pricesFetchedAt = (port: PlansPort) => new Date(priceCache.get(port)?.at ?? Date.now());

/** Failed coupon guesses per user (D-189): over the limit = 429 before Stripe is asked. Valid codes give the try back. */
export const COUPON_TRIES = { max: 10, windowMs: 15 * 60_000 };
const tries = new Map<string, number[]>();
/** ponytail: in-process window (one API instance today, Q-008); move to account_events.takeSlot once the enum has `coupon_attempted` (CCR-007). */
function takeTry(userId: string) {
  const now = Date.now();
  // Drop students whose window is over, so the map doesn't keep everyone who ever typed a code.
  for (const [k, v] of tries) if (v.every((t) => now - t >= COUPON_TRIES.windowMs)) tries.delete(k);
  const list = (tries.get(userId) ?? []).filter((t) => now - t < COUPON_TRIES.windowMs);
  if (list.length >= COUPON_TRIES.max) return (tries.set(userId, list), null);
  const mark = now + Math.random(); // unique entry so release removes exactly this one
  list.push(mark);
  tries.set(userId, list);
  return () => tries.set(userId, (tries.get(userId) ?? []).filter((t) => t !== mark));
}
export async function checkedPromotion(port: PlansPort, userId: string, code: string, customerId: string | null): Promise<Promo | null | 'rate_limited'> {
  const release = takeTry(userId);
  if (!release) return 'rate_limited';
  const promo = await port.promotion(code, customerId).catch((e: unknown) => (release(), Promise.reject(e)));
  if (promo) release(); // only wrong guesses count
  return promo;
}

/** D-101/D-189: the coupon (`couponCode ?? coupon`) is re-validated against Stripe here; the client's price is never used. */
export const createCheckout = (stripe: StripePort) => async (userId: string, input: CheckoutInput): Promise<Result<RedirectUrl>> => {
  const raw = input.couponCode ?? input.coupon;
  const code = raw === undefined ? null : couponCodeSchema.safeParse(raw);
  if (code && !code.success) return err('validation', 'invalid coupon');
  const lifetime = input.period === 'lifetime';
  // D-375: coupons (FUNDADOR included) are for Pro periods only; Founder is a fixed price.
  if (code && lifetime) return err('validation', 'coupon not applicable');
  const plans = plansPort(stripe);
  if (!plans) return err('internal', 'billing unavailable');
  const key = `checkout:${userId}:${input.period}:${input.method}:${code?.data ?? ''}`;
  return once(key, async () => {
    const { db, subscriptions } = await dbm();
    const [row] = await db.select(pick(subscriptions, 'plan', 'status', 'stripeCustomerId', 'stripeSubscriptionId', 'cancelAtPeriodEnd')).from(subscriptions).where(eq(subscriptions.userId, userId));
    // A second checkout over a live card subscription would orphan it (still charging, invisible to portal and deleteAccount).
    // Also when cancellation is scheduled (F15 review B2): reactivating the old one in the portal would charge it again unseen; the UI offers "Reativar".
    if (row?.plan === 'founder') return err('conflict', 'already founder');
    // Founder over a live card Pro is allowed: the webhook cancels that subscription once Founder is paid (D-375).
    if (!lifetime && row?.stripeSubscriptionId && row.plan === 'pro' && row.status !== 'canceled') return err('conflict', row.cancelAtPeriodEnd ? 'reactivate' : 'already subscribed');
    let promo: Promo | undefined;
    if (code) {
      const p = await checkedPromotion(plans, userId, code.data, row?.stripeCustomerId ?? null);
      if (p === 'rate_limited') return err('rate_limited', 'too many coupon attempts');
      if (!p) return err('validation', 'invalid coupon');
      promo = p;
    }
    let customerId = row?.stripeCustomerId;
    if (!customerId) {
      customerId = await stripe.createCustomer(userId);
      await db.insert(subscriptions).values({ userId, stripeCustomerId: customerId }).onConflictDoUpdate({ target: subscriptions.userId, set: { stripeCustomerId: customerId } });
    }
    const book = await cachedPrices(plans);
    const idempotencyKey = `${key}:${Math.floor(Date.now() / DOUBLE_CLICK_MS)}`;
    return ok({ url: await stripe.checkout({ userId, customerId, period: input.period, method: input.method, amount: book[input.period].amount, promo, idempotencyKey }) });
  });
};

export const openPortal = (stripe: StripePort) => async (userId: string, input: PortalInput): Promise<Result<RedirectUrl>> => {
  const { db, subscriptions } = await dbm();
  const [row] = await db.select(pick(subscriptions, 'stripeCustomerId', 'stripeSubscriptionId')).from(subscriptions).where(eq(subscriptions.userId, userId));
  if (!row?.stripeCustomerId) return err('not_found', 'no billing account');
  return ok({ url: await stripe.portal({ userId, customerId: row.stripeCustomerId, subscriptionId: row.stripeSubscriptionId, cancel: !!input.cancel }) });
};
