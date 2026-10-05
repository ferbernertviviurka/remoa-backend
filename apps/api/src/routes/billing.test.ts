// Integration: needs local Supabase (see matrix.test.ts); skipped otherwise. Stripe is faked at the port; webhook signatures are real (offline).
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextChargeDate } from '@remoa/contracts';
import type { CheckoutArgs, PlansPort, SessionInfo, StripePort } from '../billing/stripe';

config({ path: '../../.env' });

const SECRET = 'whsec_test';
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe.skipIf(!process.env.DATABASE_URL)('/v1/billing + /v1/stripe', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let mockApp: typeof app;
  let mock: ReturnType<typeof import('../billing/stripe').createMockStripe>;
  const checkouts: CheckoutArgs[] = [];
  let subInfo = { status: 'active', renewsAt: new Date(Date.now() + 30 * 86_400_000), cancelAtPeriodEnd: false };
  // F15 fake state: Stripe prices, promotion codes, checkout sessions, Pix payments and card subscription details.
  const PRICES = { monthly: { amount: 4200, priceId: 'price_m' }, annual: { amount: 39900, priceId: 'price_a' }, lifetime: { amount: 59990, priceId: 'price_l' } };
  let priceCalls = 0;
  let customers = 0;
  const sessions = new Map<string, SessionInfo>();
  const pixPaid = new Map<string, { period: 'monthly' | 'annual' | 'lifetime'; amount: number }>();
  const planDetail = new Map<string, { period: 'monthly' | 'annual'; amount: number; itemId: string }>();
  const canceled: string[] = [];
  const switches: Parameters<PlansPort['switchAnnual']>[0][] = [];
  const fake: StripePort & PlansPort = {
    createCustomer: async () => (customers++, `cus_${uuid()}`),
    checkout: async (a) => (checkouts.push(a), 'https://stripe.test/c'),
    portal: async ({ cancel }) => `https://stripe.test/p?cancel=${cancel}`,
    subscription: async () => subInfo,
    cancelNow: async (id) => void canceled.push(id),
    prices: async () => (priceCalls++, PRICES),
    promotion: async (code) =>
      code === 'FUNDADOR' ? { discount: { promotion_code: 'promo_fundador' }, percentOff: 50, amountOff: null }
      : code === 'MENOS10' ? { discount: { coupon: 'cpn_10' }, percentOff: null, amountOff: 1000 }
      : null,
    session: async (id) => sessions.get(id) ?? null,
    lastPayment: async (customerId) => pixPaid.get(customerId) ?? null,
    plan: async (id) => planDetail.get(id) ?? { period: 'monthly', amount: 4200, itemId: 'si_1' },
    switchAnnual: async (a) => (switches.push(a), { kind: 'switched', renewsAt: new Date('2031-01-01T00:00:00Z'), amount: 39900 }),
  };

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (a: typeof app, user: string, path: string, body: unknown) => {
    const res = await a.request(`/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { data?: { url: string }; error?: { code: string; message?: string } } };
  };
  type Body<T> = { data?: T; error?: { code: string; message?: string } };
  const get = async <T = Record<string, unknown>>(a: typeof app, user: string, path: string) => {
    const res = await a.request(`/v1${path}`, { headers: { authorization: `Bearer ${user}` } });
    return { status: res.status, json: (await res.json()) as Body<T> };
  };
  const post = async <T = Record<string, unknown>>(a: typeof app, user: string, path: string, body: unknown = {}) => {
    const res = await a.request(`/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Body<T> };
  };
  const hook = (event: object, sig?: string) => {
    const payload = JSON.stringify(event);
    return app.request('/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': sig ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) } });
  };
  const sub = async (u: string) => (await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u)))[0]!;
  const evt = (type: string, object: object) => ({ id: `evt_${uuid()}`, type, data: { object } });
  const cardCheckout = (u: string, subscription: string) => evt('checkout.session.completed', { mode: 'subscription', payment_status: 'paid', client_reference_id: u, customer: 'cus_1', subscription, metadata: { userId: u, period: 'monthly' } });
  const subObj = (id: string, extra: object) => ({ id, status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: sec(new Date('2030-01-01')) }] }, ...extra });

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_COUPON_FUNDADOR = 'cpn_fundador';
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    const { createMockStripe } = await import('../billing/stripe');
    const verifyToken = async (t: string) => (users.includes(t) ? t : null);
    app = createApp({ webOrigin: 'http://web.test', verifyToken, stripe: fake });
    mock = createMockStripe({ apiOrigin: 'http://api.test' });
    mockApp = createApp({ webOrigin: 'http://web.test', verifyToken, stripe: mock.port, mockStripe: mock });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('checkout validates input, rejects unknown coupons, passes method/period/discount to the port', async () => {
    const u = await newUser();
    expect((await call(app, u, '/billing/checkout', { period: 'weekly', method: 'card' })).status).toBe(422);
    expect((await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card', coupon: 'NOPE' })).status).toBe(422);
    expect((await app.request('/v1/billing/checkout', { method: 'POST' })).status).toBe(401);
    const ok = await call(app, u, '/billing/checkout', { period: 'annual', method: 'pix', coupon: 'fundador' });
    expect(ok.json.data!.url).toBe('https://stripe.test/c');
    expect(checkouts.at(-1)).toMatchObject({ userId: u, period: 'annual', method: 'pix', promo: { discount: { promotion_code: 'promo_fundador' } } });
    await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card' });
    expect(checkouts.at(-1)).toMatchObject({ method: 'card', promo: undefined });
    const customers = new Set(checkouts.filter((c) => c.userId === u).map((c) => c.customerId));
    expect(customers.size).toBe(1); // reused
    expect((await sub(u)).stripeCustomerId).toBe([...customers][0]);
  });

  it('F15 B2: no second card checkout while the card subscription is set to cancel (409 reactivate)', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    await hook(cardCheckout(u, id));
    const live = subInfo;
    subInfo = { status: 'active', renewsAt: new Date('2030-01-01'), cancelAtPeriodEnd: true };
    await hook(evt('customer.subscription.updated', subObj(id, { cancel_at_period_end: true })));
    subInfo = live;
    const r = await call(app, u, '/billing/checkout', { period: 'annual', method: 'card' });
    expect(r.status).toBe(409);
    expect(r.json.error?.message).toBe('reactivate');
  });

  it('portal needs a billing account; cancel flag reaches the port', async () => {
    const u = await newUser();
    expect((await call(app, u, '/billing/portal', {})).status).toBe(404);
    await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card' });
    expect((await call(app, u, '/billing/portal', { cancel: true })).json.data!.url).toContain('cancel=true');
  });

  it('webhook: bad or missing signature -> 400, nothing written', async () => {
    const u = await newUser();
    const e = cardCheckout(u, 'sub_bad');
    expect((await hook(e, 't=1,v1=deadbeef')).status).toBe(400);
    expect((await app.request('/v1/stripe/webhook', { method: 'POST', body: JSON.stringify(e) })).status).toBe(400);
    expect(await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u))).toHaveLength(0);
  });

  it('webhook: lifecycle (card checkout, invoice.paid, payment_failed, cancel, deleted) and unknown type', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    expect((await hook(cardCheckout(u, id))).status).toBe(200);
    expect(await sub(u)).toMatchObject({ plan: 'pro', status: 'active', stripeSubscriptionId: id, stripeCustomerId: 'cus_1', cancelAtPeriodEnd: false });
    const renewed = new Date('2031-02-03T00:00:00Z');
    await hook(evt('invoice.paid', { subscription: id, lines: { data: [{ period: { end: sec(renewed) } }] } }));
    expect((await sub(u)).renewsAt).toEqual(renewed);
    await hook(evt('invoice.payment_failed', { subscription: id }));
    expect(await sub(u)).toMatchObject({ status: 'past_due', plan: 'pro', renewsAt: renewed });
    // The handler re-reads the live subscription (Stripe doesn't order events): a stale payload can't undo the cancel.
    const live = subInfo;
    subInfo = { status: 'active', renewsAt: new Date('2030-01-01'), cancelAtPeriodEnd: true };
    await hook(evt('customer.subscription.updated', subObj(id, { cancel_at_period_end: true })));
    expect(await sub(u)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, renewsAt: new Date('2030-01-01') });
    await hook(evt('customer.subscription.updated', subObj(id, { cancel_at_period_end: false }))); // late, stale delivery
    expect(await sub(u)).toMatchObject({ cancelAtPeriodEnd: true });
    subInfo = live;
    await hook(evt('customer.subscription.deleted', { id }));
    expect(await sub(u)).toMatchObject({ plan: 'free', status: 'canceled', cancelAtPeriodEnd: false });
    const unknown = await hook(evt('customer.created', {}));
    expect(unknown.status).toBe(200);
  });

  it('webhook: pix payment gives Pro until period end without renewal; unpaid session ignored', async () => {
    const u = await newUser();
    const s = { mode: 'payment', client_reference_id: u, customer: 'cus_p', metadata: { userId: u, period: 'annual' } };
    await hook(evt('checkout.session.completed', { ...s, payment_status: 'unpaid' }));
    expect(await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u))).toHaveLength(0);
    await hook(evt('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid' }));
    const row = await sub(u);
    expect(row).toMatchObject({ plan: 'pro', status: 'active', cancelAtPeriodEnd: true, stripeSubscriptionId: null });
    expect(row.renewsAt!.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    // Buying again while the period runs extends from the current expiry (remaining days are kept).
    await hook(evt('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid', metadata: { userId: u, period: 'monthly' } }));
    const again = await sub(u);
    expect(again.renewsAt!.getTime() - row.renewsAt!.getTime()).toBeGreaterThan(27 * 86_400_000);
  });

  it('checkout over a live card subscription is 409 (would orphan a charging subscription)', async () => {
    const u = await newUser();
    await hook(cardCheckout(u, `sub_${uuid()}`));
    expect((await call(app, u, '/billing/checkout', { period: 'monthly', method: 'pix' })).status).toBe(409);
  });

  it('webhook: basil invoice shape (parent.subscription_details) and foreign checkout sessions', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    await hook(cardCheckout(u, id));
    await hook(evt('invoice.payment_failed', { parent: { subscription_details: { subscription: id } } }));
    expect((await sub(u)).status).toBe('past_due');
    const foreign = await hook(evt('checkout.session.completed', { mode: 'payment', payment_status: 'paid', customer: 'cus_x' }));
    expect([foreign.status, (await foreign.json()).data.result]).toEqual([200, 'ignored']);
  });

  // Second review (G05): fixed in webhook.ts (metadata.userId must match client_reference_id; no_payment_required grants).
  it('webhook: a paid session we did not create (Payment Link with ?client_reference_id=) must not grant Pro', async () => {
    const u = await newUser();
    // Payment Links accept client_reference_id from the URL; session metadata comes from the link, never from our checkout.
    await hook(evt('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: u, customer: 'cus_link', metadata: {} }));
    expect((await get(app, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'free' });
  });

  it('webhook: a card checkout fully covered by a coupon (no_payment_required) grants Pro, like the return page says', async () => {
    const u = await newUser();
    await hook(evt('checkout.session.completed', { mode: 'subscription', payment_status: 'no_payment_required', client_reference_id: u, customer: 'cus_1', subscription: `sub_${uuid()}`, metadata: { userId: u, period: 'monthly' } }));
    expect((await get(app, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'pro' });
  });

  it('webhook: concurrent deliveries of the same event apply once', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    await hook(cardCheckout(u, id));
    const paid = evt('invoice.paid', { subscription: id, lines: { data: [{ period: { end: sec(new Date('2032-01-01')) } }] } });
    const results = await Promise.all(Array.from({ length: 5 }, async () => (await (await hook(paid)).json()).data.result));
    expect(results.sort()).toEqual(['applied', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  });

  it('webhook: replaying an event id does not re-apply it', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    await hook(cardCheckout(u, id));
    const paid = evt('invoice.paid', { subscription: id, lines: { data: [{ period: { end: sec(new Date('2031-01-01')) } }] } });
    expect((await (await hook(paid)).json()).data.result).toBe('applied');
    await dbm.db.update(dbm.subscriptions).set({ renewsAt: new Date('2029-01-01') }).where(eq(dbm.subscriptions.userId, u));
    expect((await (await hook(paid)).json()).data.result).toBe('duplicate');
    expect((await sub(u)).renewsAt).toEqual(new Date('2029-01-01'));
  });

  it('mock: checkout -> Pro active; portal cancel -> cancel_at_period_end; sessions are one-shot', async () => {
    const u = await newUser();
    const { json } = await call(mockApp, u, '/billing/checkout', { period: 'monthly', method: 'card' });
    const url = new URL(json.data!.url);
    expect(url.pathname).toBe('/v1/stripe/mock/checkout');
    const res = await mockApp.request(url.pathname + url.search);
    expect([res.status, res.headers.get('location')]).toEqual([302, `http://web.test/app/planos/sucesso?session_id=${url.searchParams.get('session')}`]);
    expect(await sub(u)).toMatchObject({ plan: 'pro', status: 'active', cancelAtPeriodEnd: false });
    expect((await mockApp.request(url.pathname + url.search)).status).toBe(404);
    const p = new URL((await call(mockApp, u, '/billing/portal', { cancel: true })).json.data!.url);
    const pr = await mockApp.request(p.pathname + p.search);
    expect(pr.headers.get('location')).toBe('http://web.test/app/conta?portal=ok');
    expect(await sub(u)).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: true });
    expect((await mockApp.request('/v1/stripe/mock/checkout?session=guess')).status).toBe(404);
    expect((await app.request('/v1/stripe/mock/checkout?session=x')).status).toBe(404); // not mounted without the mock
  });
  // --- F15 (D-188–D-192) ---
  const owner = (u: string) => (c: CheckoutArgs) => c.userId === u;
  const mockSession = (url: string) => new URL(url).searchParams.get('session')!;

  it('F15 prices: Stripe Prices cached in process, next charge in the profile timezone; Pix charges the same amount', async () => {
    const u = await newUser();
    const before = priceCalls;
    const a = await get(app, u, '/billing/prices');
    const b = await get(app, u, '/billing/prices');
    expect(a.status).toBe(200);
    expect(a.json.data).toMatchObject({ monthly: { amount: 4200, currency: 'brl', priceId: 'price_m' }, annual: { amount: 39900, currency: 'brl', priceId: 'price_a' } });
    expect(priceCalls - before).toBeLessThanOrEqual(1); // cached (0 if an earlier test warmed it)
    expect(b.json.data!.fetchedAt).toBe(a.json.data!.fetchedAt);
    const now = new Date();
    expect(a.json.data!.nextChargeOn).toEqual({ monthly: nextChargeDate('monthly', now, 'America/Sao_Paulo'), annual: nextChargeDate('annual', now, 'America/Sao_Paulo') });
    for (const period of ['monthly', 'annual'] as const) {
      await call(app, u, '/billing/checkout', { period, method: 'pix' });
      expect(checkouts.filter(owner(u)).at(-1)!.amount).toBe((a.json.data as { [k: string]: { amount: number } })[period]!.amount);
    }
    const m = await get(mockApp, u, '/billing/prices');
    expect(m.json.data).toMatchObject({ monthly: { amount: 3900 }, annual: { amount: 34900 } }); // STRIPE=mock = PRICES_BRL
  });

  it('F15 coupon: valid codes return discounted prices; invalid is exactly { valid: false }; checkout re-validates', async () => {
    const u = await newUser();
    expect((await post(app, u, '/billing/coupon', { code: ' fundador ' })).json.data).toEqual({ valid: true, kind: 'percent', monthly: 2100, annual: 19950 });
    expect((await post(app, u, '/billing/coupon', { code: 'MENOS10' })).json.data).toEqual({ valid: true, kind: 'amount', monthly: 3200, annual: 38900 });
    expect((await post(app, u, '/billing/coupon', { code: 'NAOEXISTE' })).json.data).toEqual({ valid: false });
    expect((await post(app, u, '/billing/coupon', { code: '<script>' })).json.data).toEqual({ valid: false });
    expect((await post(app, u, '/billing/coupon', {})).json.data).toEqual({ valid: false });
    expect((await post(mockApp, u, '/billing/coupon', { code: 'FUNDADOR' })).json.data).toEqual({ valid: true, kind: 'percent', monthly: 2925, annual: 26175 });
    // Forged/unknown code straight to checkout: refused, no session.
    const n = checkouts.length;
    expect((await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card', couponCode: 'FORJADO' })).status).toBe(422);
    expect(checkouts.length).toBe(n);
    await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card', couponCode: 'menos10' });
    expect(checkouts.at(-1)).toMatchObject({ userId: u, promo: { discount: { coupon: 'cpn_10' } }, amount: 4200 }); // table price; Stripe applies the discount
  });

  it('F15 coupon: wrong guesses are limited (429 rate_limited), also through checkout; another student is unaffected', async () => {
    const u = await newUser();
    const { COUPON_TRIES } = await import('../billing/checkout');
    // Valid codes do not count.
    for (let i = 0; i < 3; i++) expect((await post(app, u, '/billing/coupon', { code: 'FUNDADOR' })).status).toBe(200);
    const results = await Promise.all(Array.from({ length: COUPON_TRIES.max + 3 }, (_, i) => post(app, u, '/billing/coupon', { code: `CHUTE${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(COUPON_TRIES.max);
    expect(results.filter((r) => r.status === 429).every((r) => r.json.error!.code === 'rate_limited')).toBe(true);
    expect((await post(app, u, '/billing/coupon', { code: 'FUNDADOR' })).status).toBe(429);
    expect((await call(app, u, '/billing/checkout', { period: 'annual', method: 'pix', couponCode: 'FUNDADOR' })).status).toBe(429);
    expect((await post(app, await newUser(), '/billing/coupon', { code: 'FUNDADOR' })).status).toBe(200);
  });

  it('F15 checkout: double click creates one session (same URL, one customer, stable idempotency key); failures are not cached', async () => {
    const u = await newUser();
    const c0 = customers;
    const [a, b] = await Promise.all([call(app, u, '/billing/checkout', { period: 'annual', method: 'card' }), call(app, u, '/billing/checkout', { period: 'annual', method: 'card' })]);
    const c = await call(app, u, '/billing/checkout', { period: 'annual', method: 'card' });
    expect([a.json.data!.url, b.json.data!.url, c.json.data!.url]).toEqual(['https://stripe.test/c', 'https://stripe.test/c', 'https://stripe.test/c']);
    const mine = checkouts.filter(owner(u));
    expect(mine).toHaveLength(1);
    expect(customers - c0).toBe(1);
    expect(mine[0]!.idempotencyKey).toMatch(new RegExp(`^checkout:${u}:annual:card::\\d+$`));
    // Another period/method is another order.
    await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card' });
    expect(checkouts.filter(owner(u))).toHaveLength(2);
    // Mock: two clicks, one session.
    const v = await newUser();
    const [x, y] = await Promise.all([call(mockApp, v, '/billing/checkout', { period: 'monthly', method: 'pix' }), call(mockApp, v, '/billing/checkout', { period: 'monthly', method: 'pix' })]);
    expect(x.json.data!.url).toBe(y.json.data!.url);
  });

  it('F15 return: session status by owner only; mapping of open/complete/expired; bad ids are 422', async () => {
    const u = await newUser();
    const other = await newUser();
    const base = { userId: u, period: 'annual', method: 'card' } as const;
    sessions.set('cs_test_paid', { ...base, status: 'complete', paymentStatus: 'paid' });
    sessions.set('cs_test_free', { ...base, status: 'complete', paymentStatus: 'no_payment_required' });
    sessions.set('cs_test_pix', { ...base, method: 'pix', status: 'complete', paymentStatus: 'unpaid' });
    sessions.set('cs_test_open', { ...base, status: 'open', paymentStatus: 'unpaid' });
    sessions.set('cs_test_exp', { ...base, status: 'expired', paymentStatus: 'unpaid' });
    sessions.set('cs_test_nouser', { ...base, userId: null, status: 'complete', paymentStatus: 'paid' });
    const st = async (id: string, who = u) => (await get(app, who, `/billing/checkout/${id}`)).json.data?.status;
    expect(await st('cs_test_paid')).toBe('paid');
    expect(await st('cs_test_free')).toBe('paid');
    expect(await st('cs_test_pix')).toBe('pending_pix');
    expect(await st('cs_test_open')).toBe('canceled');
    expect(await st('cs_test_exp')).toBe('expired');
    expect((await get(app, u, '/billing/checkout/cs_test_paid')).json.data).toEqual({ status: 'paid', plan: 'pro', period: 'annual', method: 'card' });
    // Another student's session, an unknown one and one without an owner look the same.
    for (const id of ['cs_test_paid', 'cs_test_unknown']) expect((await get(app, other, `/billing/checkout/${id}`)).status).toBe(404);
    expect((await get(app, u, '/billing/checkout/cs_test_nouser')).status).toBe(404);
    expect((await get(app, u, '/billing/checkout/cs_x%27%3B--')).status).toBe(422);
    expect((await get(app, u, '/billing/checkout/sub_123')).status).toBe(422);
    // A paid session does not grant Pro by itself (D-181): only the webhook does.
    expect((await get(app, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'free' });
  });

  it('F15 mock Pix pending: the return says pending and Pro is NOT granted until the webhook confirms', async () => {
    const u = await newUser();
    const url = new URL((await call(mockApp, u, '/billing/checkout', { period: 'monthly', method: 'pix', couponCode: 'FUNDADOR' })).json.data!.url);
    const id = mockSession(url.href);
    const res = await mockApp.request(`${url.pathname}${url.search}&pix=pending`);
    expect([res.status, res.headers.get('location')]).toEqual([302, `http://web.test/app/planos/sucesso?session_id=${id}`]);
    expect((await get(mockApp, u, `/billing/checkout/${id}`)).json.data).toEqual({ status: 'pending_pix', plan: 'pro', period: 'monthly', method: 'pix' });
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'free' });
    expect(await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u))).toMatchObject([{ plan: 'free' }]);
    expect((await get(mockApp, u, '/billing/subscription')).json.data).toBeNull();
    // Replaying the return URL (or forging session_id) changes nothing.
    expect((await mockApp.request(`${url.pathname}${url.search}`)).status).toBe(404);
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'free' });
    // The Pix arrives (async_payment_succeeded through the webhook handler).
    const ok = await mockApp.request(`/v1/stripe/mock/pix-confirm?session=${id}`);
    expect([ok.status, ((await ok.json()) as Body<{ result: string }>).data!.result]).toEqual([200, 'applied']);
    expect((await mockApp.request(`/v1/stripe/mock/pix-confirm?session=${id}`)).status).toBe(404);
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'pro' });
    expect((await get(mockApp, u, `/billing/checkout/${id}`)).json.data!.status).toBe('paid');
    expect((await get(mockApp, u, '/billing/subscription')).json.data).toMatchObject({ method: 'pix', period: 'monthly', amount: 2925, cancelAtPeriodEnd: true, pastDue: false });
  });

  it('F15 mock card: paid return; canceled return keeps Free and the session can still be paid', async () => {
    const u = await newUser();
    const first = new URL((await call(mockApp, u, '/billing/checkout', { period: 'annual', method: 'card' })).json.data!.url);
    const id = mockSession(first.href);
    const cancel = await mockApp.request(`/v1/stripe/mock/checkout/cancel?session=${id}`);
    expect([cancel.status, cancel.headers.get('location')]).toEqual([302, 'http://web.test/app/planos?cancelado=1']);
    expect((await get(mockApp, u, `/billing/checkout/${id}`)).json.data!.status).toBe('canceled');
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'free' });
    await mockApp.request(first.pathname + first.search);
    expect((await get(mockApp, u, `/billing/checkout/${id}`)).json.data!.status).toBe('paid');
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'pro' });
    expect((await mockApp.request(`/v1/stripe/mock/checkout/cancel?session=${id}`)).status).toBe(404);
    expect((await get(mockApp, u, '/billing/subscription')).json.data).toMatchObject({ method: 'card', period: 'annual', amount: 34900, status: 'active' });
    expect((await post(mockApp, u, '/billing/switch-annual')).status).toBe(409); // already annual
  });

  it('F15 subscription summary: null for Free; card amount from Stripe; past_due flagged', async () => {
    const u = await newUser();
    expect((await get(app, u, '/billing/subscription')).json).toEqual({ ok: true, data: null });
    const id = `sub_${uuid()}`;
    planDetail.set(id, { period: 'monthly', amount: 2100, itemId: 'si_x' });
    await hook(cardCheckout(u, id));
    expect((await get(app, u, '/billing/subscription')).json.data).toMatchObject({ status: 'active', method: 'card', period: 'monthly', amount: 2100, pastDue: false, cancelAtPeriodEnd: false });
    await hook(evt('invoice.payment_failed', { subscription: id }));
    const s = (await get(app, u, '/billing/subscription')).json.data!;
    expect(s).toMatchObject({ status: 'past_due', pastDue: true });
    expect(s.graceUntil).not.toBeNull();
  });

  it('F15 switch-annual: card monthly prorates in place once; not monthly/Free/cancel scheduled is 409; Pix monthly redirects to an annual Pix checkout', async () => {
    const free = await newUser();
    expect((await post(app, free, '/billing/switch-annual')).json.error!.code).toBe('conflict');

    const u = await newUser();
    const id = `sub_${uuid()}`;
    planDetail.set(id, { period: 'monthly', amount: 4200, itemId: 'si_m' });
    await hook(cardCheckout(u, id));
    const n = switches.length;
    const [a, b] = await Promise.all([post(app, u, '/billing/switch-annual'), post(app, u, '/billing/switch-annual')]);
    expect(a.json.data).toEqual({ kind: 'switched', renewsAt: '2031-01-01T00:00:00.000Z', amount: 39900 });
    expect(b.json.data).toEqual(a.json.data);
    expect(switches.length - n).toBe(1);
    expect(switches.at(-1)).toMatchObject({ subscriptionId: id, itemId: 'si_m' });

    const annual = await newUser();
    const ida = `sub_${uuid()}`;
    planDetail.set(ida, { period: 'annual', amount: 39900, itemId: 'si_a' });
    await hook(cardCheckout(annual, ida));
    expect((await post(app, annual, '/billing/switch-annual')).status).toBe(409);

    const leaving = await newUser();
    const idl = `sub_${uuid()}`;
    await hook(cardCheckout(leaving, idl));
    await dbm.db.update(dbm.subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(dbm.subscriptions.userId, leaving));
    expect((await post(app, leaving, '/billing/switch-annual')).status).toBe(409);

    const pix = await newUser();
    await hook(evt('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: pix, customer: `cus_${pix}`, metadata: { userId: pix, period: 'monthly' } }));
    pixPaid.set(`cus_${pix}`, { period: 'monthly', amount: 4200 });
    const r = await post(app, pix, '/billing/switch-annual');
    expect(r.json.data).toEqual({ kind: 'redirect', url: 'https://stripe.test/c' });
    expect(checkouts.at(-1)).toMatchObject({ userId: pix, period: 'annual', method: 'pix', amount: 39900 });
    pixPaid.set(`cus_${pix}`, { period: 'annual', amount: 39900 });
    expect((await post(app, pix, '/billing/switch-annual')).status).toBe(409);
  });

  it('F15 without a Stripe port: new endpoints answer 500 internal', async () => {
    const { createApp } = await import('../app');
    const bare = createApp({ webOrigin: 'http://web.test', verifyToken: async (t) => (users.includes(t) ? t : null) });
    const u = await newUser();
    for (const r of [await get(bare, u, '/billing/prices'), await post(bare, u, '/billing/coupon', { code: 'X' }), await get(bare, u, '/billing/checkout/cs_1'), await get(bare, u, '/billing/subscription'), await post(bare, u, '/billing/switch-annual')]) expect(r.status).toBe(500);
  });

  // --- Founder (D-375) ---
  const founderPaid = (u: string, customer = 'cus_f') =>
    evt('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: u, customer, metadata: { userId: u, period: 'lifetime' } });
  const unlimited = { ai_grades: null, ai_generations: null, boards: null, cards: null };

  it('founder checkout: lifetime price, Pix or card, no coupon; allowed over a live card Pro; a founder cannot buy again', async () => {
    const u = await newUser();
    expect((await call(app, u, '/billing/checkout', { period: 'lifetime', method: 'card', couponCode: 'FUNDADOR' })).json.error).toMatchObject({ code: 'validation', message: 'coupon not applicable' });
    for (const method of ['pix', 'card'] as const) {
      expect((await call(app, u, '/billing/checkout', { period: 'lifetime', method })).status).toBe(200);
      expect(checkouts.filter(owner(u)).at(-1)).toMatchObject({ period: 'lifetime', method, amount: 59990, promo: undefined });
    }
    expect((await get(app, u, '/billing/prices')).json.data).toMatchObject({ lifetime: { amount: 59990, currency: 'brl' } });
    await hook(cardCheckout(u, `sub_${uuid()}`));
    expect((await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card' })).status).toBe(409);
    expect((await call(app, u, '/billing/checkout', { period: 'lifetime', method: 'card' })).status).toBe(200);
    await hook(founderPaid(u));
    const again = await call(app, u, '/billing/checkout', { period: 'annual', method: 'pix' }); // lifetime keys are still in the double-click window
    expect([again.status, again.json.error?.message]).toEqual([409, 'already founder']);
  });

  it('founder webhook: lifetime, no expiry, unlimited AI; the Pro subscription is canceled and its later events never downgrade', async () => {
    const u = await newUser();
    const id = `sub_${uuid()}`;
    await hook(cardCheckout(u, id));
    expect((await hook(founderPaid(u))).status).toBe(200);
    expect(canceled).toContain(id);
    expect(await sub(u)).toMatchObject({ plan: 'founder', status: 'active', renewsAt: null, stripeSubscriptionId: null, cancelAtPeriodEnd: false });
    const ent = (await get(app, u, '/billing/entitlements')).json.data;
    expect(ent).toMatchObject({ plan: 'founder', status: 'active', limits: unlimited, renewsAt: null, graceUntil: null, cancelAtPeriodEnd: false });
    // Leftover Pro events and a late Pro Pix payment.
    await hook(evt('invoice.payment_failed', { subscription: id }));
    await hook(evt('customer.subscription.deleted', { id }));
    await hook(evt('checkout.session.completed', { mode: 'payment', payment_status: 'paid', client_reference_id: u, customer: 'cus_f', metadata: { userId: u, period: 'monthly' } }));
    expect(await sub(u)).toMatchObject({ plan: 'founder', status: 'active', renewsAt: null });
    // No period end, grace or lapse: still Founder decades later.
    const { planOf } = await import('../billing/plan');
    expect(await planOf(u, new Date('2100-01-01T00:00:00Z'))).toMatchObject({ plan: 'founder', renewsAt: null, graceUntil: null, grantUntil: null });
    const { limitFor } = await import('../billing/quota');
    expect(await limitFor(u, 'ai_generations', new Date('2100-01-01T00:00:00Z'))).toBeNull();
    pixPaid.set('cus_f', { period: 'lifetime', amount: 59990 });
    expect((await get(app, u, '/billing/subscription')).json.data).toMatchObject({ period: 'lifetime', amount: 59990, renewsAt: null, pastDue: false });
    expect((await post(app, u, '/billing/switch-annual')).status).toBe(409);
  });

  it('founder with STRIPE=mock: card lifetime is a one-time payment (no subscription), paid return says founder', async () => {
    const u = await newUser();
    const url = new URL((await call(mockApp, u, '/billing/checkout', { period: 'lifetime', method: 'card' })).json.data!.url);
    expect((await mockApp.request(url.pathname + url.search)).status).toBe(302);
    expect(await sub(u)).toMatchObject({ plan: 'founder', status: 'active', renewsAt: null, stripeSubscriptionId: null });
    expect((await get(mockApp, u, `/billing/checkout/${mockSession(url.href)}`)).json.data).toEqual({ status: 'paid', plan: 'founder', period: 'lifetime', method: 'card' });
    expect((await get(mockApp, u, '/billing/entitlements')).json.data).toMatchObject({ plan: 'founder', limits: unlimited });
    expect((await get(mockApp, u, '/billing/subscription')).json.data).toMatchObject({ period: 'lifetime', method: 'card', amount: 59990, renewsAt: null });
    expect((await get(mockApp, u, '/billing/prices')).json.data).toMatchObject({ lifetime: { amount: 59990 } });
  });
});
