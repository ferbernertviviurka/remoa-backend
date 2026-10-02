// Integration: needs local Supabase (see matrix.test.ts); skipped otherwise. Stripe is faked at the port; webhook signatures are real (offline).
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutArgs, StripePort } from '../billing/stripe';

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
  const fake: StripePort = {
    createCustomer: async () => `cus_${uuid()}`,
    checkout: async (a) => (checkouts.push(a), 'https://stripe.test/c'),
    portal: async ({ cancel }) => `https://stripe.test/p?cancel=${cancel}`,
    subscription: async () => subInfo,
    cancelNow: async () => {},
  };

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (a: typeof app, user: string, path: string, body: unknown) => {
    const res = await a.request(`/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { data?: { url: string }; error?: { code: string } } };
  };
  const hook = (event: object, sig?: string) => {
    const payload = JSON.stringify(event);
    return app.request('/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': sig ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) } });
  };
  const sub = async (u: string) => (await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u)))[0]!;
  const evt = (type: string, object: object) => ({ id: `evt_${uuid()}`, type, data: { object } });
  const cardCheckout = (u: string, subscription: string) => evt('checkout.session.completed', { mode: 'subscription', payment_status: 'paid', client_reference_id: u, customer: 'cus_1', subscription, metadata: { period: 'monthly' } });
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
    expect(checkouts.at(-1)).toMatchObject({ userId: u, period: 'annual', method: 'pix', fundador: true });
    await call(app, u, '/billing/checkout', { period: 'monthly', method: 'card' });
    expect(checkouts.at(-1)).toMatchObject({ method: 'card', fundador: false });
    const customers = new Set(checkouts.filter((c) => c.userId === u).map((c) => c.customerId));
    expect(customers.size).toBe(1); // reused
    expect((await sub(u)).stripeCustomerId).toBe([...customers][0]);
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
    const s = { mode: 'payment', client_reference_id: u, customer: 'cus_p', metadata: { period: 'annual' } };
    await hook(evt('checkout.session.completed', { ...s, payment_status: 'unpaid' }));
    expect(await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u))).toHaveLength(0);
    await hook(evt('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid' }));
    const row = await sub(u);
    expect(row).toMatchObject({ plan: 'pro', status: 'active', cancelAtPeriodEnd: true, stripeSubscriptionId: null });
    expect(row.renewsAt!.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    // Buying again while the period runs extends from the current expiry (remaining days are kept).
    await hook(evt('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid', metadata: { period: 'monthly' } }));
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
    expect([res.status, res.headers.get('location')]).toEqual([302, 'http://web.test/conta?checkout=ok']);
    expect(await sub(u)).toMatchObject({ plan: 'pro', status: 'active', cancelAtPeriodEnd: false });
    expect((await mockApp.request(url.pathname + url.search)).status).toBe(404);
    const p = new URL((await call(mockApp, u, '/billing/portal', { cancel: true })).json.data!.url);
    const pr = await mockApp.request(p.pathname + p.search);
    expect(pr.headers.get('location')).toBe('http://web.test/conta?portal=ok');
    expect(await sub(u)).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: true });
    expect((await mockApp.request('/v1/stripe/mock/checkout?session=guess')).status).toBe(404);
    expect((await app.request('/v1/stripe/mock/checkout?session=x')).status).toBe(404); // not mounted without the mock
  });
});
