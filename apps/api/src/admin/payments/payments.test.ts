// Integration (F19 T4): payments mirror from the F08 webhook + admin actions through the real withAdmin. Needs local Supabase.
// The admin identity is stubbed (requireAdmin is T3's); Stripe is a fake PaymentsPort (no network).
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@remoa/log';
import { adminPaymentDetailSchema, adminPaymentPageSchema } from '@remoa/contracts';
import type { AdminEnv } from '../core';
import type { StripePort } from '../../billing/stripe';
import type { PaymentsPort } from './port';
import { templateOf } from '../../test-email';

config({ path: '../../.env' });
type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!process.env.DATABASE_URL)('F19 payments (mirror + /v1/admin/payments)', () => {
  let dbm: typeof import('@remoa/db');
  let webhook: typeof import('../../billing/webhook');
  let portMod: typeof import('./port');
  let sent: Awaited<ReturnType<typeof import('../../test-email')['captureEmails']>>;
  let core: typeof import('../core');
  let app: Hono<AdminEnv>;
  const users: string[] = [];
  const pis: string[] = [];
  const adm = uuid();
  const stripe = {} as StripePort; // the Pix/Founder paths of applyStripeEvent never call it here
  let authAt = Date.now();
  const refunds: string[] = [];
  let refundFails = false;
  let invoicePi: string | null = null;
  const fake: PaymentsPort = {
    invoicePayment: async () => invoicePi,
    refund: async ({ idempotencyKey }) => {
      if (refundFails) throw new Error('card_declined');
      refunds.push(idempotencyKey);
    },
    receiptUrl: async ({ paymentIntent }) => `https://pay.stripe.test/receipts/${paymentIntent}`,
  };

  const mk = async (name = 'Aluna Teste') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data) values (${id}, ${id + '@test.local'}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ name })}::jsonb)`);
    await dbm.db.update(dbm.profiles).set({ name }).where(eq(dbm.profiles.userId, id));
    return id;
  };
  const newPi = () => {
    const pi = `pi_t4_${uuid().replace(/-/g, '')}`;
    pis.push(pi);
    return pi;
  };
  let evt = 0;
  const ev = (type: string, object: Record<string, unknown>, id = `evt_t4_${uuid()}_${evt++}`) => ({ id, type, data: { object } });
  const pixSession = (user: string, pi: string, paid: boolean, period = 'monthly') => ({
    mode: 'payment', payment_status: paid ? 'paid' : 'unpaid', client_reference_id: user, customer: `cus_${user.slice(0, 8)}`, subscription: null,
    payment_intent: pi, amount_total: period === 'lifetime' ? 59990 : 4200, metadata: { userId: user, period, method: 'pix' },
  });
  const apply = (e: ReturnType<typeof ev>) => webhook.applyStripeEvent(e, stripe);
  const row = async (id: string) => (await dbm.db.select().from(dbm.payments).where(eq(dbm.payments.id, id)))[0];
  const sub = async (user: string) => (await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, user)))[0];
  const audits = (id: string) => dbm.db.select().from(dbm.adminAuditLog).where(eq(dbm.adminAuditLog.targetId, id)).orderBy(dbm.adminAuditLog.id);
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(`/payments${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };
  /** A paid Pix (pending → paid through the webhook): returns its PaymentIntent. */
  const paidPix = async (user: string, period = 'monthly') => {
    const pi = newPi();
    await apply(ev('checkout.session.completed', pixSession(user, pi, false, period)));
    await apply(ev('checkout.session.async_payment_succeeded', pixSession(user, pi, true, period)));
    return pi;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    webhook = await import('../../billing/webhook');
    portMod = await import('./port');
    sent = (await import('../../test-email')).captureEmails();
    core = await import('../core');
    const { paymentsRoutes } = await import('./routes');
    portMod.setPaymentsPort(fake);
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('admin', { id: adm, name: 'Equipe', email: 'e@test.local' });
      c.set('authAt', authAt);
      c.set('requestId', 'r-t4');
      c.set('log', createLogger({ requestId: 'r-t4' }));
      await next();
    });
    app.route('/payments', paymentsRoutes);
  });
  beforeEach(() => {
    authAt = Date.now();
    refundFails = false;
    invoicePi = null;
  });
  afterAll(async () => {
    portMod?.setPaymentsPort(undefined);
    if (!dbm) return;
    if (pis.length) await dbm.db.execute(sql`delete from payments where id in (${sql.join(pis.map((p) => sql`${p}`), sql`, `)}) or user_id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('mirror: Pix pending → paid with timeline; same event twice and in parallel = one row; foreign sessions ignored', async () => {
    const u = await mk();
    const pi = newPi();
    const created = ev('checkout.session.completed', pixSession(u, pi, false));
    expect(await apply(created)).toBe('applied');
    expect(await apply(created)).toBe('duplicate');
    let r = await row(pi);
    expect(r).toMatchObject({ status: 'pending', method: 'pix', item: 'pro_monthly', amountCents: 4200, userId: u });
    expect(r!.events.map((e) => e.type)).toEqual(['checkout_created', 'pix_generated']);
    expect((await sub(u))?.plan ?? 'free').toBe('free');

    const paid = ev('checkout.session.async_payment_succeeded', pixSession(u, pi, true));
    expect(await Promise.all([apply(paid), apply(paid)])).toEqual(expect.arrayContaining(['applied', 'duplicate']));
    r = await row(pi);
    expect(r!.status).toBe('paid');
    expect(r!.events.map((e) => e.type)).toEqual(['checkout_created', 'pix_generated', 'paid', 'plan_released']);
    expect((await sub(u))?.plan).toBe('pro');
    // A late "pending" replay with a new event id never moves it back.
    await apply(ev('checkout.session.completed', pixSession(u, pi, false)));
    expect((await row(pi))!.status).toBe('paid');

    // Not ours (no metadata.userId) and subscription-mode sessions: no row.
    const other = newPi();
    expect(await apply(ev('checkout.session.completed', { ...pixSession(u, other, true), metadata: {} }))).toBe('ignored');
    expect(await row(other)).toBeUndefined();
  });

  it('mirror: Pix expired → failed; invoices keyed by PaymentIntent (lookup), annual item, credit method, renewal and failure', async () => {
    const u = await mk();
    const pi = newPi();
    await apply(ev('checkout.session.completed', pixSession(u, pi, false)));
    await apply(ev('checkout.session.async_payment_failed', pixSession(u, pi, false)));
    expect((await row(pi))!.status).toBe('failed');
    expect((await row(pi))!.events.at(-1)!.type).toBe('failed');

    const subId = `sub_t4_${uuid()}`;
    await dbm.db.insert(dbm.subscriptions).values({ userId: u, plan: 'pro', status: 'active', stripeSubscriptionId: subId, stripeCustomerId: 'cus_t4' })
      .onConflictDoUpdate({ target: dbm.subscriptions.userId, set: { plan: 'pro', stripeSubscriptionId: subId } });
    const now = Math.floor(Date.now() / 1000);
    const inv = (id: string, extra: Record<string, unknown> = {}) => ({
      id, customer: 'cus_t4', amount_paid: 39900, amount_due: 39900, billing_reason: 'subscription_create', starting_balance: 0,
      parent: { subscription_details: { subscription: subId } }, lines: { data: [{ period: { start: now, end: now + 365 * 86_400 } }] }, ...extra,
    });
    invoicePi = newPi();
    await apply(ev('invoice.paid', inv(`in_t4_${uuid()}`)));
    expect(await row(invoicePi)).toMatchObject({ status: 'paid', method: 'card', item: 'pro_annual', userId: u, stripeSubscriptionId: subId });
    expect((await row(invoicePi))!.events.map((e) => e.type)).toEqual(['checkout_created', 'card_authorized', 'paid', 'plan_released']);

    // Paid entirely by the referral credit (no PaymentIntent): keyed by the invoice id, method credit.
    invoicePi = null;
    const credit = `in_t4_${uuid()}`;
    pis.push(credit);
    await apply(ev('invoice.paid', inv(credit, { amount_paid: 0, amount_due: 0, starting_balance: -4200, billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: now, end: now + 30 * 86_400 } }] } })));
    expect(await row(credit)).toMatchObject({ status: 'paid', method: 'credit', item: 'pro_monthly', amountCents: 0 });

    invoicePi = newPi();
    await apply(ev('invoice.payment_failed', inv(`in_t4_${uuid()}`, { billing_reason: 'subscription_cycle' })));
    expect(await row(invoicePi)).toMatchObject({ status: 'failed', amountCents: 39900 });
    // A refund event for a payment we never mirrored, or with an unknown shape, is ignored (no row, no error).
    expect(await apply(ev('charge.refunded', { payment_intent: 'pi_t4_never', refunded: true }))).toBe('applied');
    expect(await apply(ev('charge.dispute.created', { id: 'dp_1' }))).toBe('ignored');
  });

  it('refund: only paid (409 + denied row otherwise); status stays paid until the webhook; double click = one Stripe call', async () => {
    const u = await mk();
    const pending = newPi();
    await apply(ev('checkout.session.completed', pixSession(u, pending, false)));
    const bad = await req(`/${pending}/refund`, 'POST', { reason: 'Cobrança duplicada' });
    expect(bad.status).toBe(409);
    expect((await audits(pending)).map((a) => [a.action, a.result, a.denial])).toEqual([['payment.refund', 'denied', 'invalid_state']]);
    expect((await req(`/pi_t4_missing/refund`, 'POST', { reason: 'Cobrança duplicada' })).status).toBe(404);

    const pi = await paidPix(u);
    const renewsBefore = (await sub(u))!.renewsAt!;
    expect((await req(`/${pi}/refund`, 'POST', { reason: 'curto' })).status).toBe(422); // missing_reason row
    const [a, b] = await Promise.all([req(`/${pi}/refund`, 'POST', { reason: 'Cobrança duplicada' }), req(`/${pi}/refund`, 'POST', { reason: 'Cobrança duplicada' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(refunds.filter((k) => k === `refund:${pi}`)).toHaveLength(1);
    let r = await row(pi);
    expect(r!.status).toBe('paid');
    expect(r!.events.at(-1)!.type).toBe('refund_requested');
    const rows = (await audits(pi)).map((x) => [x.result, x.denial]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([['denied', 'missing_reason'], ['success', null], ['denied', 'invalid_state']]));

    // Stripe confirms (pending refund first is ignored), twice and in parallel: one refunded row, one stripe audit row, plan reviewed.
    await apply(ev('charge.refunded', { payment_intent: pi, refunded: true, refunds: { data: [{ status: 'pending' }] } }));
    expect((await row(pi))!.status).toBe('paid');
    const confirm = ev('charge.refunded', { payment_intent: pi, refunded: true, amount_refunded: 4200 });
    await Promise.all([apply(confirm), apply(confirm), apply(ev('refund.updated', { payment_intent: pi, status: 'succeeded', amount: 4200 }))]);
    r = await row(pi);
    expect(r!.status).toBe('refunded');
    expect(r!.refundedAt).not.toBeNull();
    const stripeRows = (await audits(pi)).filter((x) => x.actorType === 'stripe');
    expect(stripeRows).toHaveLength(1);
    expect(stripeRows[0]).toMatchObject({ action: 'payment.webhook', result: 'success', after: { status: 'refunded', plan: 'pix_period_removed' } });
    // D-457: the refunded Pix month is taken back (renews_at − 1 month ⇒ Free now).
    expect((await sub(u))!.renewsAt!.getTime()).toBeLessThan(renewsBefore.getTime() - 27 * 86_400_000);
  });

  it('refund: Stripe failure leaves nothing changed and a denied error row; stale reauth is refused; Founder refund revokes Founder', async () => {
    const u = await mk();
    const pi = await paidPix(u, 'lifetime');
    expect((await sub(u))!.plan).toBe('founder');
    refundFails = true;
    const f = await req(`/${pi}/refund`, 'POST', { reason: 'Pedido do aluno' });
    expect(f.status).toBe(500);
    expect((await row(pi))!.events.some((e) => e.type === 'refund_requested')).toBe(false);
    expect((await audits(pi)).at(-1)).toMatchObject({ result: 'denied', denial: 'error' });
    refundFails = false;
    authAt = Date.now() - 31 * 60_000;
    expect((await req(`/${pi}/refund`, 'POST', { reason: 'Pedido do aluno' })).json.error?.message).toBe('reauth_required');
    authAt = Date.now();
    expect((await req(`/${pi}/refund`, 'POST', { reason: 'Pedido do aluno' })).status).toBe(200);
    await apply(ev('refund.created', { payment_intent: pi, status: 'succeeded', amount: 59990 }));
    expect((await row(pi))!.status).toBe('refunded');
    expect((await sub(u))!.plan).toBe('free');
  });

  it('mark-paid: only pending, needs checked; releases the plan like the webhook; the real Pix event later does not release twice', async () => {
    const u = await mk();
    const pi = newPi();
    const session = pixSession(u, pi, false);
    await apply(ev('checkout.session.completed', session));
    const n0 = (await audits(pi)).length;
    expect((await req(`/${pi}/mark-paid`, 'POST', { reason: 'Conferido no Stripe' })).status).toBe(422); // no `checked`: no audit row
    expect((await audits(pi)).length).toBe(n0);
    const ok = await req(`/${pi}/mark-paid`, 'POST', { reason: 'Conferido no Stripe', checked: true });
    expect(ok.status).toBe(200);
    expect(ok.json.data.audit).toMatchObject({ action: 'payment.mark_paid', result: 'success', after: { status: 'paid', planReleased: true } });
    const r = await row(pi);
    expect(r!.status).toBe('paid');
    expect(r!.events.map((e) => e.type)).toEqual(['checkout_created', 'pix_generated', 'marked_paid', 'plan_released']);
    const s1 = await sub(u);
    expect(s1!.plan).toBe('pro');
    expect(s1!.renewsAt!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect((await req(`/${pi}/mark-paid`, 'POST', { reason: 'Conferido no Stripe', checked: true })).status).toBe(409);
    // Stripe delivers the confirmation afterwards: mirrored, not applied to the plan again.
    await apply(ev('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }));
    expect((await sub(u))!.renewsAt!.getTime()).toBe(s1!.renewsAt!.getTime());
    expect((await row(pi))!.status).toBe('paid');
  });

  it('mark-paid vs the real Pix event at the same instant: the webhook waits for the admin row lock and does not release twice', async () => {
    const u = await mk();
    const pi = newPi();
    const session = pixSession(u, pi, false);
    await apply(ev('checkout.session.completed', session));
    let pending: Promise<unknown> | null = null;
    await dbm.db.transaction(async (tx) => {
      // what mark-paid holds while it releases the plan: the row lock + `marked_paid`, not committed yet
      const [p] = await tx.select().from(dbm.payments).where(eq(dbm.payments.id, pi)).for('update');
      await tx.update(dbm.payments).set({ status: 'paid', events: [...p!.events, { type: 'marked_paid', at: new Date().toISOString() }] }).where(eq(dbm.payments.id, pi));
      pending = apply(ev('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }));
      await new Promise((r) => setTimeout(r, 300));
    });
    await pending;
    expect(await sub(u)).toBeUndefined(); // the plan was released by the admin path only (not simulated here): never by the webhook too
    expect((await row(pi))!.events.map((e) => e.type)).not.toContain('plan_released');
  });

  it('G18: one purchase notice per confirmed payment, values from the event; a replay or a late duplicate adds none', async () => {
    const u = await mk('Davi Pagante');
    const pi = newPi();
    await apply(ev('checkout.session.completed', pixSession(u, pi, false)));
    const mine = () => dbm.db.execute<{ data: { orderId: string; planName: string } }>(sql`select data from notifications where user_id = ${u} and type = 'purchase'`);
    expect(await mine()).toHaveLength(0); // pending Pix: nothing yet
    const paid = ev('checkout.session.async_payment_succeeded', pixSession(u, pi, true));
    await apply(paid);
    await apply(paid); // same event id
    await apply(ev('checkout.session.async_payment_succeeded', pixSession(u, pi, true))); // another event, same payment: already paid
    expect((await mine()).map((r) => r.data.orderId)).toEqual([pi]);
    const mails = sent.filter((m) => m.to === `${u}@test.local` && templateOf(m) === 'purchase-success');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('42,00'); // 4200 cents from the event, formatted by @remoa/emails
  });

  it('resend-receipt: e-mails the Stripe receipt to the account; pending is 409', async () => {
    const u = await mk('Carla Souza');
    const pi = await paidPix(u);
    const receipts = () => sent.filter((m) => m.to === `${u}@test.local` && templateOf(m) === 'payment-receipt');
    const r = await req(`/${pi}/resend-receipt`, 'POST', { reason: 'Aluno pediu o recibo' });
    expect(r.status).toBe(200);
    const mail = receipts().at(-1)!;
    expect(receipts()).toHaveLength(1);
    expect(mail.text).toContain(`https://pay.stripe.test/receipts/${pi}`);
    expect(JSON.stringify(r.json.data.audit.after)).not.toContain('@');
    expect((await req(`/${pi}/resend-receipt`, 'POST', { reason: 'Aluno pediu de novo' })).status).toBe(200); // a new reference each time: a second copy goes out
    expect(receipts()).toHaveLength(2);
    const pend = newPi();
    await apply(ev('checkout.session.completed', pixSession(u, pend, false)));
    expect((await req(`/${pend}/resend-receipt`, 'POST', { reason: 'Aluno pediu o recibo' })).status).toBe(409);
  });

  it('list (search, filters, summary) and detail (timeline, Stripe ids, audit trail); export rows', async () => {
    const u = await mk('Beatriz Listada');
    const pi = await paidPix(u);
    const pend = newPi();
    await apply(ev('checkout.session.completed', pixSession(u, pend, false)));
    const l = await req(`?q=${encodeURIComponent(`${u}@test`)}`);
    expect(l.status).toBe(200);
    const page = adminPaymentPageSchema.parse(l.json.data);
    expect(page.total).toBe(2);
    expect(page.summary).toMatchObject({ paid: 1, pending: 1, failed: 0, refunded: 0, receivedCents: 4200 });
    const onlyPaid = adminPaymentPageSchema.parse((await req(`?q=Beatriz%20Listada&status=paid&method=pix&period=7`)).json.data);
    expect(onlyPaid.items.map((i) => i.id)).toEqual([pi]);
    expect(onlyPaid.summary.pending).toBe(1); // summary ignores the status filter
    expect(adminPaymentPageSchema.parse((await req(`?q=${pi.slice(0, 20)}`)).json.data).items.map((i) => i.id)).toContain(pi);
    expect((await req('?status=nope')).status).toBe(422);

    await req(`/${pi}/resend-receipt`, 'POST', { reason: 'Aluno pediu o recibo' });
    const d = adminPaymentDetailSchema.parse((await req(`/${pi}`)).json.data);
    expect(d).toMatchObject({ stripePaymentIntent: pi, stripeCustomerId: `cus_${u.slice(0, 8)}`, user: { id: u, name: 'Beatriz Listada' } });
    expect(d.timeline.map((e) => e.type)).toEqual(['checkout_created', 'pix_generated', 'paid', 'plan_released']);
    expect(d.audit.map((a) => a.action)).toEqual(['payment.resend_receipt']);
    expect((await req('/pi_t4_unknown')).status).toBe(404);

    const exp = core.getExport('payments')!;
    const out = await dbm.db.transaction((tx) => exp({ q: u }, tx));
    expect(out.ok && out.data.rows.length).toBe(2);
    expect((await dbm.db.transaction((tx) => exp({ status: 'nope' }, tx))).ok).toBe(false);
  });
});
