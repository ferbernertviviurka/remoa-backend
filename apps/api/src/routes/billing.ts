import { Hono } from 'hono';
import { checkoutInputSchema, errorHttpStatus, parseWith, portalInputSchema, err, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { getEntitlements } from '../billing/entitlements';
import { createCheckout, openPortal } from '../billing/checkout';
import type { StripePort } from '../billing/stripe';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

/** F08. `stripe` absent (no STRIPE_SECRET) = checkout/portal answer `internal`. */
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
    });
};
