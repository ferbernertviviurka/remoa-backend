import { Hono } from 'hono';
import Stripe from 'stripe';
import { fail, type Env } from '../app';
import { applyStripeEvent } from '../billing/webhook';
import type { createMockStripe, StripePort } from '../billing/stripe';

/** F08. Webhook is public: auth = signature over the raw body. Mock endpoints exist only when STRIPE=mock injected `mock`. */
export const stripeRoutes = ({ stripe, mock, webOrigin }: { stripe?: StripePort; mock?: ReturnType<typeof createMockStripe>; webOrigin: string }) => {
  const app = new Hono<Env>().post('/webhook', async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = c.req.header('stripe-signature');
    let event: Stripe.Event;
    try {
      if (!secret || !sig || !stripe) throw new Error('unconfigured');
      event = Stripe.webhooks.constructEvent(await c.req.text(), sig, secret);
    } catch {
      c.get('log').warn('stripe webhook rejected');
      return Response.json({ error: { code: 'validation', message: 'invalid signature' } }, { status: 400 });
    }
    const r = await applyStripeEvent(event, stripe);
    c.get('log').info('stripe event', { type: event.type, result: r });
    return c.json({ ok: true, data: { result: r } });
  });
  if (!mock || !stripe) return app;
  const replay = (kind: 'checkout' | 'portal') => async (c: import('hono').Context<Env>) => {
    const event = mock.mockEvent(kind, c.req.query('session') ?? '');
    if (!event) return fail({ code: 'not_found', message: 'unknown session' });
    await applyStripeEvent(event, stripe);
    return c.redirect(`${webOrigin}/conta?${kind}=ok`, 302);
  };
  return app.get('/mock/checkout', replay('checkout')).get('/mock/portal', replay('portal'));
};
