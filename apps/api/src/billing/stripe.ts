import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { PRICES_BRL, type CheckoutInput } from '@remoa/contracts';

type BillingPeriod = CheckoutInput['period'];
export type SubscriptionInfo = { status: string; renewsAt: Date; cancelAtPeriodEnd: boolean };
export type CheckoutArgs = { userId: string; customerId: string; period: BillingPeriod; method: 'pix' | 'card'; fundador: boolean };

/** F08 Stripe port (like the grader port): the real SDK in prod, a fake in dev/e2e (STRIPE=mock). Returns redirect URLs. */
export type StripePort = {
  createCustomer: (userId: string) => Promise<string>;
  checkout: (a: CheckoutArgs) => Promise<string>;
  portal: (a: { userId: string; customerId: string; subscriptionId: string | null; cancel: boolean }) => Promise<string>;
  subscription: (id: string) => Promise<SubscriptionInfo>;
  /** LGPD delete: stop charging now (the webhook's subscription.deleted moves the row to free). */
  cancelNow: (subscriptionId: string) => Promise<void>;
};

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const unix = (s: number) => new Date(s * 1000);

export const createStripe = ({ secret, webOrigin }: { secret: string; webOrigin: string }): StripePort => {
  const s = new Stripe(secret);
  return {
    createCustomer: async (userId) => (await s.customers.create({ metadata: { userId } })).id,
    checkout: async ({ userId, customerId, period, method, fundador }) => {
      const base = {
        customer: customerId,
        client_reference_id: userId,
        metadata: { userId, period },
        discounts: fundador ? [{ coupon: need('STRIPE_COUPON_FUNDADOR') }] : undefined,
        success_url: `${webOrigin}/conta?checkout=ok`,
        cancel_url: `${webOrigin}/conta?checkout=cancel`,
      };
      const session =
        method === 'card'
          ? await s.checkout.sessions.create({
              ...base,
              mode: 'subscription',
              allowed_payment_method_types: ['card'],
              line_items: [{ price: need(period === 'monthly' ? 'STRIPE_PRICE_MONTHLY' : 'STRIPE_PRICE_ANNUAL'), quantity: 1 }],
            })
          : await s.checkout.sessions.create({
              ...base,
              mode: 'payment',
              allowed_payment_method_types: ['pix'],
              // Pix is one-time only (D-100): a recurring price id is rejected in payment mode, so charge the table price.
              line_items: [{ price_data: { currency: 'brl', unit_amount: PRICES_BRL[period] * 100, product_data: { name: 'Remoa Pro' } }, quantity: 1 }],
            });
      return session.url ?? Promise.reject(new Error('stripe: no checkout url'));
    },
    portal: async ({ customerId, subscriptionId, cancel }) =>
      (
        await s.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${webOrigin}/conta?portal=ok`,
          flow_data:
            cancel && subscriptionId
              ? { type: 'subscription_cancel', subscription_cancel: { subscription: subscriptionId }, after_completion: { type: 'redirect', redirect: { return_url: `${webOrigin}/conta?portal=ok` } } }
              : undefined,
        })
      ).url,
    subscription: async (id) => {
      const sub = await s.subscriptions.retrieve(id);
      return { status: sub.status, renewsAt: unix(sub.items.data[0]!.current_period_end), cancelAtPeriodEnd: sub.cancel_at_period_end };
    },
    cancelNow: async (id) => {
      // Already gone at Stripe (missed webhook) = nothing left to charge; must not block the LGPD delete forever.
      await s.subscriptions.cancel(id).catch((e: { code?: string }) => (e?.code === 'resource_missing' ? undefined : Promise.reject(e)));
    },
  };
};

type MockSession = { userId: string; kind: 'checkout' | 'portal'; period?: BillingPeriod; method?: 'pix' | 'card'; customerId: string; subscriptionId?: string | null; cancel?: boolean };
type MockEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

const rid = (p: string) => `${p}_mock_${randomBytes(12).toString('hex')}`;
export const addPeriod = (from: Date, period: BillingPeriod) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (period === 'annual' ? 12 : 1));
  return d;
};

/** Dev/e2e fake. Session ids are random and map to the user in memory only; `mockEvent` builds the synthetic webhook event. */
export const createMockStripe = ({ apiOrigin }: { apiOrigin: string }) => {
  const sessions = new Map<string, MockSession>();
  const subs = new Map<string, SubscriptionInfo>();
  const open = (kind: 'checkout' | 'portal', s: Omit<MockSession, 'kind'>) => {
    const id = rid('cs');
    sessions.set(id, { ...s, kind });
    return `${apiOrigin}/v1/stripe/mock/${kind}?session=${id}`;
  };
  const port: StripePort = {
    createCustomer: async () => rid('cus'),
    checkout: async (a) => open('checkout', a),
    portal: async (a) => open('portal', a),
    subscription: async (id) => subs.get(id) ?? Promise.reject(new Error('unknown mock subscription')),
    cancelNow: async (id) => {
      subs.delete(id);
    },
  };
  const mockEvent = (kind: 'checkout' | 'portal', sessionId: string): MockEvent | null => {
    const s = sessions.get(sessionId);
    if (!s || s.kind !== kind) return null;
    sessions.delete(sessionId); // one-shot
    const id = rid('evt');
    if (kind === 'checkout') {
      const card = s.method === 'card';
      const subscription = card ? rid('sub') : null;
      if (subscription) subs.set(subscription, { status: 'active', renewsAt: addPeriod(new Date(), s.period!), cancelAtPeriodEnd: false });
      return { id, type: 'checkout.session.completed', data: { object: { mode: card ? 'subscription' : 'payment', payment_status: 'paid', client_reference_id: s.userId, customer: s.customerId, subscription, metadata: { period: s.period } } } };
    }
    if (!s.cancel || !s.subscriptionId) return { id, type: 'mock.noop', data: { object: {} } };
    const sub = subs.get(s.subscriptionId);
    if (sub) sub.cancelAtPeriodEnd = true;
    return { id, type: 'customer.subscription.updated', data: { object: { id: s.subscriptionId, status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: Math.floor((sub?.renewsAt ?? new Date()).getTime() / 1000) }] } } } };
  };
  return { port, mockEvent };
};
