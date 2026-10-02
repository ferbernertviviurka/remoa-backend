import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { PRICES_BRL, type BillingPeriod, type PaymentMethod, type SwitchToAnnualResult } from '@remoa/contracts';

/** F15: `period`/`amount`/`itemId` only come from F15 lookups (`plan`), the webhook reads the first three fields. */
export type SubscriptionInfo = { status: string; renewsAt: Date; cancelAtPeriodEnd: boolean; period?: BillingPeriod; amount?: number; itemId?: string };
/** F15: a validated promotion code (or the F08 FUNDADOR coupon). Off amounts in centavos BRL. */
export type Promo = { discount: { promotion_code: string } | { coupon: string }; percentOff: number | null; amountOff: number | null };
/** `amount` = PriceBook amount in centavos (Pix charges it via price_data so it never differs from the screen, D-188). */
export type CheckoutArgs = { userId: string; customerId: string; period: BillingPeriod; method: PaymentMethod; amount: number; promo?: Promo; idempotencyKey: string };
export type SessionInfo = { userId: string | null; status: string; paymentStatus: string; period: BillingPeriod; method: PaymentMethod };
export type PriceList = Record<BillingPeriod, { amount: number; priceId?: string }>;

/** F15 additions. Optional on the port so F08 fakes keep compiling; routes answer `internal` when absent. */
export type PlansPort = {
  prices: () => Promise<PriceList>;
  /** null = unknown, inactive, expired, exhausted, restricted to another customer, or not in BRL. */
  promotion: (code: string, customerId: string | null) => Promise<Promo | null>;
  /** null = no such session. */
  session: (id: string) => Promise<SessionInfo | null>;
  /** Last paid Pix (payment-mode) checkout of the customer: what the table doesn't store. */
  lastPayment: (customerId: string) => Promise<{ period: BillingPeriod; amount: number } | null>;
  /** Card subscription details for the summary/switch. */
  plan: (subscriptionId: string) => Promise<Required<Pick<SubscriptionInfo, 'period' | 'amount' | 'itemId'>>>;
  switchAnnual: (a: { customerId: string; subscriptionId: string; itemId: string; idempotencyKey: string }) => Promise<SwitchToAnnualResult>;
};

/** F08 Stripe port (like the grader port): the real SDK in prod, a fake in dev/e2e (STRIPE=mock). Returns redirect URLs. */
export type StripePort = {
  createCustomer: (userId: string) => Promise<string>;
  checkout: (a: CheckoutArgs) => Promise<string>;
  portal: (a: { userId: string; customerId: string; subscriptionId: string | null; cancel: boolean }) => Promise<string>;
  subscription: (id: string) => Promise<SubscriptionInfo>;
  /** LGPD delete: stop charging now (the webhook's subscription.deleted moves the row to free). */
  cancelNow: (subscriptionId: string) => Promise<void>;
} & Partial<PlansPort>;

export const plansPort = (s: StripePort | undefined) =>
  s?.prices && s.promotion && s.session && s.lastPayment && s.plan && s.switchAnnual ? (s as StripePort & PlansPort) : null;

/** Price after a coupon, the way Stripe computes it (percent rounded to the centavo, never below zero). */
export const discounted = (amount: number, off?: Pick<Promo, 'percentOff' | 'amountOff'> | null) =>
  !off ? amount : Math.max(0, off.percentOff != null ? amount - Math.round((amount * off.percentOff) / 100) : amount - (off.amountOff ?? 0));

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const unix = (s: number) => new Date(s * 1000);
const periods = new Set<string>(['monthly', 'annual']);
const periodOf = (v: unknown): BillingPeriod => (periods.has(String(v)) ? (v as BillingPeriod) : 'monthly');

/** Coupon → off amounts in BRL; null when it can't discount a BRL price. */
const offOf = (c: Stripe.Coupon | null | undefined) => {
  if (!c?.valid) return null;
  const amountOff = c.amount_off == null ? null : c.currency === 'brl' ? c.amount_off : (c.currency_options?.brl?.amount_off ?? null);
  return c.percent_off == null && amountOff == null ? null : { percentOff: c.percent_off, amountOff };
};

export const createStripe = ({ secret, webOrigin }: { secret: string; webOrigin: string }): StripePort => {
  const s = new Stripe(secret);
  const missing = (e: { code?: string }) => (e?.code === 'resource_missing' ? null : Promise.reject(e));
  const subDetail = async (sub: Stripe.Subscription) => {
    const item = sub.items.data[0]!;
    const d = sub.discounts.find((x): x is Stripe.Discount => typeof x !== 'string');
    const c = d?.source.coupon;
    const coupon = typeof c === 'string' ? await s.coupons.retrieve(c) : c;
    return { period: item.price.recurring?.interval === 'year' ? ('annual' as const) : ('monthly' as const), amount: discounted(item.price.unit_amount ?? 0, offOf(coupon)), itemId: item.id, renewsAt: unix(item.current_period_end) };
  };
  return {
    // Same key for the same user: a double click can't create two customers, even across instances (24 h Stripe window).
    createCustomer: async (userId) => (await s.customers.create({ metadata: { userId } }, { idempotencyKey: `customer:${userId}` })).id,
    checkout: async ({ userId, customerId, period, method, amount, promo, idempotencyKey }) => {
      const base = {
        customer: customerId,
        client_reference_id: userId,
        metadata: { userId, period, method },
        discounts: promo ? [promo.discount] : undefined,
        success_url: `${webOrigin}/planos/sucesso?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${webOrigin}/planos?cancelado=1`,
      };
      const session =
        method === 'card'
          ? await s.checkout.sessions.create(
              { ...base, mode: 'subscription', allowed_payment_method_types: ['card'], line_items: [{ price: need(period === 'monthly' ? 'STRIPE_PRICE_MONTHLY' : 'STRIPE_PRICE_ANNUAL'), quantity: 1 }] },
              { idempotencyKey },
            )
          : await s.checkout.sessions.create(
              {
                ...base,
                mode: 'payment',
                allowed_payment_method_types: ['pix'],
                // Pix is one-time only (D-101): a recurring price id is rejected in payment mode, so charge the PriceBook amount (D-188).
                line_items: [{ price_data: { currency: 'brl', unit_amount: amount, product_data: { name: 'Remoa Pro' } }, quantity: 1 }],
              },
              { idempotencyKey },
            );
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
    // --- F15 ---
    prices: async () => {
      const read = async (k: string) => {
        const p = await s.prices.retrieve(need(k));
        if (p.currency !== 'brl' || p.unit_amount == null) throw new Error(`stripe: ${k} is not a fixed BRL price`);
        return { amount: p.unit_amount, priceId: p.id };
      };
      const [monthly, annual] = await Promise.all([read('STRIPE_PRICE_MONTHLY'), read('STRIPE_PRICE_ANNUAL')]);
      return { monthly, annual };
    },
    promotion: async (code, customerId) => {
      const [p] = (await s.promotionCodes.list({ code, active: true, limit: 1, expand: ['data.promotion.coupon'] })).data;
      if (p) {
        const owner = typeof p.customer === 'string' ? p.customer : (p.customer?.id ?? null);
        const usable = (!owner || owner === customerId) && (!p.expires_at || p.expires_at * 1000 > Date.now()) && (p.max_redemptions == null || p.times_redeemed < p.max_redemptions);
        const c = p.promotion.coupon;
        const off = usable ? offOf(typeof c === 'string' ? await s.coupons.retrieve(c) : c) : null;
        // Other restrictions (first_time_transaction, minimum_amount, applies_to) are enforced by Stripe when the session is created.
        return off && { discount: { promotion_code: p.id }, ...off };
      }
      // D-101 compatibility: FUNDADOR without a promotion code maps to the STRIPE_COUPON_FUNDADOR coupon.
      const legacy = code === 'FUNDADOR' ? process.env.STRIPE_COUPON_FUNDADOR : undefined;
      const off = legacy ? offOf(await s.coupons.retrieve(legacy).catch(missing)) : null;
      return off && legacy ? { discount: { coupon: legacy }, ...off } : null;
    },
    session: async (id) => {
      const x = await s.checkout.sessions.retrieve(id).catch(missing);
      if (!x) return null;
      return {
        userId: x.client_reference_id ?? x.metadata?.userId ?? null,
        status: x.status ?? 'open',
        paymentStatus: x.payment_status,
        period: periodOf(x.metadata?.period),
        method: x.metadata?.method === 'pix' || x.metadata?.method === 'card' ? x.metadata.method : x.mode === 'subscription' ? 'card' : 'pix',
      };
    },
    lastPayment: async (customer) => {
      const list = await s.checkout.sessions.list({ customer, status: 'complete', limit: 20 });
      const x = list.data.find((v) => v.mode === 'payment' && v.payment_status === 'paid');
      return x ? { period: periodOf(x.metadata?.period), amount: x.amount_total ?? 0 } : null;
    },
    plan: async (id) => subDetail(await s.subscriptions.retrieve(id, { expand: ['discounts'] })),
    // D-190: change the price in place, Stripe prorates. Interval change bills now; if the card needs SCA (or is declined)
    // error_if_incomplete leaves the subscription untouched and the portal confirms the same change with the student present.
    switchAnnual: async ({ customerId, subscriptionId, itemId, idempotencyKey }) => {
      const price = need('STRIPE_PRICE_ANNUAL');
      try {
        const sub = await s.subscriptions.update(
          subscriptionId,
          { items: [{ id: itemId, price }], proration_behavior: 'create_prorations', payment_behavior: 'error_if_incomplete', expand: ['discounts'] },
          { idempotencyKey },
        );
        const d = await subDetail(sub);
        return { kind: 'switched', renewsAt: d.renewsAt, amount: d.amount };
      } catch (e) {
        if ((e as { type?: string })?.type !== 'StripeCardError') throw e;
        const back = { type: 'redirect' as const, redirect: { return_url: `${webOrigin}/planos` } };
        const portal = await s.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${webOrigin}/planos`,
          flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscriptionId, items: [{ id: itemId, price, quantity: 1 }] }, after_completion: back },
        });
        return { kind: 'redirect', url: portal.url };
      }
    },
  };
};

type MockSession = {
  userId: string; kind: 'checkout' | 'portal'; customerId: string; period?: BillingPeriod; method?: PaymentMethod; subscriptionId?: string | null; cancel?: boolean;
  state?: 'open' | 'complete' | 'expired'; paid?: boolean; total?: number;
};
type MockEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

const rid = (p: string) => `${p}_mock_${randomBytes(12).toString('hex')}`;
/** Calendar months, day clamped to the month's end like Stripe and `nextChargeDate` (Jan 31 → Feb 28/29, not Mar 3). UTC. */
export const addPeriod = (from: Date, period: BillingPeriod) => {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (period === 'annual' ? 12 : 1));
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d;
};

const MOCK_PRICES: PriceList = { monthly: { amount: PRICES_BRL.monthly * 100 }, annual: { amount: PRICES_BRL.annual * 100 } };
/** Mock FUNDADOR (Q-024: real values come from the Stripe promotion code). */
const MOCK_FUNDADOR: Promo = { discount: { coupon: 'cpn_mock_fundador' }, percentOff: 25, amountOff: null };

/** Dev/e2e fake. Session ids are random and map to the user in memory only; `mockEvent` builds the synthetic webhook event. */
export const createMockStripe = ({ apiOrigin }: { apiOrigin: string }) => {
  const sessions = new Map<string, MockSession>();
  const subs = new Map<string, SubscriptionInfo>();
  const open = (kind: 'checkout' | 'portal', s: Omit<MockSession, 'kind'>) => {
    const id = rid('cs');
    sessions.set(id, { ...s, kind });
    return `${apiOrigin}/v1/stripe/mock/${kind}?session=${id}`;
  };
  // Same idempotency key = same session, like Stripe.
  const byKey = new Map<string, string>();
  const port: StripePort & PlansPort = {
    createCustomer: async () => rid('cus'),
    checkout: async (a) => {
      const hit = byKey.get(a.idempotencyKey);
      if (hit) return hit;
      const url = open('checkout', { userId: a.userId, customerId: a.customerId, period: a.period, method: a.method, state: 'open', paid: false, total: discounted(a.amount, a.promo) });
      byKey.set(a.idempotencyKey, url);
      return url;
    },
    portal: async (a) => open('portal', a),
    subscription: async (id) => subs.get(id) ?? Promise.reject(new Error('unknown mock subscription')),
    cancelNow: async (id) => {
      subs.delete(id);
    },
    prices: async () => MOCK_PRICES,
    promotion: async (code) => (code === 'FUNDADOR' ? MOCK_FUNDADOR : null),
    session: async (id) => {
      const s = sessions.get(id);
      return s?.kind === 'checkout' ? { userId: s.userId, status: s.state!, paymentStatus: s.paid ? 'paid' : 'unpaid', period: s.period!, method: s.method! } : null;
    },
    lastPayment: async (customerId) => {
      const s = [...sessions.values()].reverse().find((v) => v.customerId === customerId && v.method === 'pix' && v.paid);
      return s ? { period: s.period!, amount: s.total! } : null;
    },
    plan: async (id) => {
      const s = subs.get(id);
      if (!s) throw new Error('unknown mock subscription');
      return { period: s.period!, amount: s.amount!, itemId: s.itemId! };
    },
    switchAnnual: async ({ subscriptionId }) => {
      const s = subs.get(subscriptionId);
      if (!s) throw new Error('unknown mock subscription');
      Object.assign(s, { period: 'annual', amount: MOCK_PRICES.annual.amount, renewsAt: addPeriod(new Date(), 'annual') });
      return { kind: 'switched', renewsAt: s.renewsAt, amount: s.amount! };
    },
  };
  const completed = (s: MockSession, type: string): MockEvent => {
    const card = s.method === 'card';
    const subscription = card ? rid('sub') : null;
    if (subscription) subs.set(subscription, { status: 'active', renewsAt: addPeriod(new Date(), s.period!), cancelAtPeriodEnd: false, period: s.period, amount: s.total, itemId: rid('si') });
    return { id: rid('evt'), type, data: { object: { mode: card ? 'subscription' : 'payment', payment_status: 'paid', client_reference_id: s.userId, customer: s.customerId, subscription, metadata: { userId: s.userId, period: s.period, method: s.method } } } };
  };
  /** `pending`: a Pix that is not paid yet (FR-8): the session completes unpaid and no event is applied until `mockPixConfirm`. */
  const mockEvent = (kind: 'checkout' | 'portal', sessionId: string, opts: { pending?: boolean } = {}): MockEvent | 'pending' | null => {
    const s = sessions.get(sessionId);
    if (!s || s.kind !== kind) return null;
    if (kind === 'checkout') {
      if (s.state !== 'open') return null; // one-shot
      s.state = 'complete';
      if (opts.pending && s.method === 'pix') return 'pending';
      s.paid = true;
      return completed(s, 'checkout.session.completed');
    }
    sessions.delete(sessionId); // one-shot
    const id = rid('evt');
    if (!s.cancel || !s.subscriptionId) return { id, type: 'mock.noop', data: { object: {} } };
    const sub = subs.get(s.subscriptionId);
    if (sub) sub.cancelAtPeriodEnd = true;
    return { id, type: 'customer.subscription.updated', data: { object: { id: s.subscriptionId, status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: Math.floor((sub?.renewsAt ?? new Date()).getTime() / 1000) }] } } } };
  };
  /** The Pix arrives: what Stripe sends as checkout.session.async_payment_succeeded. One-shot. */
  const mockPixConfirm = (sessionId: string): MockEvent | null => {
    const s = sessions.get(sessionId);
    if (s?.kind !== 'checkout' || s.state !== 'complete' || s.paid) return null;
    s.paid = true;
    return completed(s, 'checkout.session.async_payment_succeeded');
  };
  /** True while the session can still be abandoned (Stripe's cancel_url leaves it open). */
  const isOpen = (sessionId: string) => sessions.get(sessionId)?.state === 'open';
  return { port, mockEvent, mockPixConfirm, isOpen };
};
