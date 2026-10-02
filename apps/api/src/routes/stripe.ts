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
  const sid = (c: import('hono').Context<Env>) => c.req.query('session') ?? '';
  // F15: the checkout returns like Stripe's success_url/cancel_url; `&pix=pending` completes a Pix unpaid (FR-8) until /mock/pix-confirm.
  const back = (id: string) => `${webOrigin}/planos/sucesso?session_id=${encodeURIComponent(id)}`;
  return app
    .get('/mock/checkout', async (c) => {
      const event = mock.mockEvent('checkout', sid(c), { pending: c.req.query('pix') === 'pending' });
      if (!event) return fail({ code: 'not_found', message: 'unknown session' });
      if (event !== 'pending') await applyStripeEvent(event, stripe);
      return c.redirect(back(sid(c)), 302);
    })
    .get('/mock/checkout/cancel', (c) => (mock.isOpen(sid(c)) ? c.redirect(`${webOrigin}/planos?cancelado=1`, 302) : fail({ code: 'not_found', message: 'unknown session' })))
    .get('/mock/pix-confirm', async (c) => {
      const event = mock.mockPixConfirm(sid(c));
      if (!event) return fail({ code: 'not_found', message: 'unknown session' });
      return c.json({ ok: true, data: { result: await applyStripeEvent(event, stripe) } });
    })
    .get('/mock/portal', async (c) => {
      const event = mock.mockEvent('portal', sid(c));
      if (!event || event === 'pending') return fail({ code: 'not_found', message: 'unknown session' });
      await applyStripeEvent(event, stripe);
      return c.redirect(`${webOrigin}/conta?portal=ok`, 302);
    });
};
