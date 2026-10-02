import { Hono } from 'hono';
import { checkoutInputSchema, checkoutSessionIdSchema, couponInputSchema, errorHttpStatus, parseWith, portalInputSchema, err, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { getEntitlements } from '../billing/entitlements';
import { createCheckout, openPortal } from '../billing/checkout';
import { getCheckoutSession, getPriceBook, getSubscription, switchToAnnual, validateCoupon } from '../billing/plans';
import type { StripePort } from '../billing/stripe';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

/** F08 + F15. `stripe` absent (no STRIPE_SECRET) = billing endpoints answer `internal`. */
export const billingRoutes = ({ stripe }: { stripe?: StripePort }) => {
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  const off = () => err('internal', 'billing unavailable');
  return new Hono<Env>()
    .get('/entitlements', async (c) => send(await getEntitlements(c.get('userId'))))
    .post('/checkout', async (c) => {
      const i = parseWith(checkoutInputSchema, await body(c));
      return send(!i.ok ? i : stripe ? await createCheckout(stripe)(c.get('userId'), i.data) : off());
    })
    .post('/portal', async (c) => {
      const i = parseWith(portalInputSchema, (await body(c)) ?? {});
      return send(!i.ok ? i : stripe ? await openPortal(stripe)(c.get('userId'), i.data) : off());
    })
    // --- F15 ---
    .get('/prices', async (c) => send(await getPriceBook(stripe)(c.get('userId'))))
    .post('/coupon', async (c) => {
      const i = parseWith(couponInputSchema, await body(c));
      // A malformed code is just an invalid one (D-185: never say why); it still counts as a guess.
      return send(await validateCoupon(stripe)(c.get('userId'), i.ok ? i.data.code : '-'));
    })
    .get('/checkout/:sessionId', async (c) => {
      const i = parseWith(checkoutSessionIdSchema, c.req.param('sessionId'));
      return send(!i.ok ? i : await getCheckoutSession(stripe)(c.get('userId'), i.data));
    })
    .get('/subscription', async (c) => send(await getSubscription(stripe)(c.get('userId'))))
    .post('/switch-annual', async (c) => send(await switchToAnnual(stripe)(c.get('userId'))));
};
