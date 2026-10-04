// F19 FR-16 (D-428, D-456–D-457): /v1/admin/payments. `payments` is a webhook mirror; the actions here never set `refunded`
// (only the webhook does). Stripe is called inside withAdmin's transaction, under the row lock, with an idempotency key: a
// Stripe failure rolls back and leaves a denied `error` row; a lost commit after a successful call is retried with the same key.
import { Hono, type Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { adminErrors, adminPaymentListQuerySchema, err, markPaidInputSchema, ok, parseWith, type AdminAction, type PaymentEventType, type Result } from '@remoa/contracts';
import type { ZodTypeAny } from 'zod';
import type { Tx } from '@remoa/db';
import { sendEmail } from '../../account/mailer';
import { applyStripeEvent } from '../../billing/webhook';
import { installedStripe, type StripePort } from '../../billing/stripe';
import { dbm } from '../../db';
import { paymentReceiptEmail } from '../../support/email-copy';
import { reasonOf, registerExport, send, withAdmin, type AdminEnv, type AuditCapture } from '../core';
import { paymentsPort } from './port';
import { getPayment, listPayments, periodOf } from './queries';

const EXPORT_MAX_ROWS = 10_000;
const conflict = () => err<never>('conflict', adminErrors.invalidState);
type Payment = typeof import('@remoa/db').payments.$inferSelect;
type C = Context<AdminEnv>;

const stamp = (p: Payment, ...types: PaymentEventType[]) => [...p.events, ...types.map((type) => ({ type, at: new Date().toISOString() }))];

/** Loads the payment once (404 without an audit row for an unknown id), then runs `fn` inside withAdmin with the row locked. */
const action = (name: AdminAction, fn: (tx: Tx, audit: AuditCapture, p: Payment, c: C) => Promise<Result<object>>, body?: ZodTypeAny) => async (c: C) => {
  const json: unknown = await c.req.json().catch(() => null);
  const other = body ? parseWith(body, json) : null; // fields besides `reason`: malformed input is a 422 without an audit row
  if (other && !other.ok) return send(other);
  const id = c.req.param('id') ?? '';
  const { db, payments: t } = await dbm();
  const [known] = await db.select({ id: t.id }).from(t).where(eq(t.id, id));
  if (!known) return send(err('not_found', 'payment not found'));
  return send(await withAdmin(c, name, { reason: reasonOf(json), target: { type: 'payment', id } }, async (tx, audit) => {
    const [p] = await tx.select().from(t).where(eq(t.id, id)).for('update');
    return fn(tx, audit, p!, c);
  }));
};

const refund = action('payment.refund', async (tx, audit, p, c) => {
  // Full amount only (P2: partial). A second click finds refund_requested and is refused: one Stripe call.
  if (p.status !== 'paid' || !p.stripePaymentIntent || p.events.some((e) => e.type === 'refund_requested')) return conflict();
  const port = paymentsPort();
  if (!port) return err('internal', 'stripe unavailable');
  audit.before({ status: p.status, amountCents: p.amountCents });
  try {
    await port.refund({ paymentIntent: p.stripePaymentIntent, idempotencyKey: `refund:${p.id}`, amountCents: p.amountCents });
  } catch (e) {
    c.get('log').error('stripe refund failed', { paymentId: p.id, error: e instanceof Error ? e.message : String(e) });
    return err('internal', 'stripe refund failed');
  }
  const { payments: t } = await dbm();
  await tx.update(t).set({ events: stamp(p, 'refund_requested'), updatedAt: new Date() }).where(eq(t.id, p.id));
  audit.after({ status: p.status, refund: 'requested' }); // `refunded` arrives with the webhook (charge.refunded / refund.updated)
  return ok({});
});

/** No Stripe in this process (tests, scripts): the Pix path of applyStripeEvent never calls it; Founder's cancelNow just logs. */
const noStripe = { cancelNow: () => Promise.reject(new Error('stripe unavailable')) } as unknown as StripePort;

const markPaid = action('payment.mark_paid', async (tx, audit, p) => {
  if (p.status !== 'pending' || !p.userId || !p.stripeCustomerId) return conflict();
  const { subscriptions: s, payments: t } = await dbm();
  // F08's Pix path overwrites the subscriptions row: never over a live card subscription (it would keep charging, orphaned).
  const [sub] = await tx.select().from(s).where(eq(s.userId, p.userId));
  if (p.item !== 'founder_lifetime' && sub?.stripeSubscriptionId && sub.status !== 'canceled') return conflict();
  audit.before({ status: p.status });
  // The exact paid path of F08: the synthetic Pix confirmation goes through applyStripeEvent. Its id makes it idempotent
  // (stripe_events), and the real Pix event arriving later is not applied again (releasedByAdmin in the webhook).
  const period = p.item === 'founder_lifetime' ? 'lifetime' : p.item === 'pro_annual' ? 'annual' : 'monthly';
  const r = await applyStripeEvent({
    id: `markpaid:${p.id}`, type: 'checkout.session.async_payment_succeeded',
    data: { object: { mode: 'payment', payment_status: 'paid', client_reference_id: p.userId, customer: p.stripeCustomerId, subscription: null, metadata: { userId: p.userId, period } } },
  }, installedStripe() ?? noStripe);
  const released = r !== 'ignored'; // ignored = already Founder (F08 keeps it)
  await tx.update(t).set({ status: 'paid', events: stamp(p, 'marked_paid', ...(released ? ['plan_released' as const] : [])), updatedAt: new Date() }).where(eq(t.id, p.id));
  audit.after({ status: 'paid', planReleased: released });
  return ok({});
}, markPaidInputSchema.omit({ reason: true }));

const resendReceipt = action('payment.resend_receipt', async (tx, audit, p, c) => {
  if ((p.status !== 'paid' && p.status !== 'refunded') || !p.userId) return conflict();
  const [u] = await tx.execute<{ email: string | null; name: string | null }>(sql`select u.email, pr.name from auth.users u left join profiles pr on pr.user_id = u.id where u.id = ${p.userId}`);
  if (!u?.email) return conflict();
  const port = paymentsPort();
  if (!port) return err('internal', 'stripe unavailable');
  try {
    const receiptUrl = await port.receiptUrl({ paymentIntent: p.stripePaymentIntent, invoiceId: p.stripeInvoiceId });
    if (!receiptUrl) return conflict();
    // Inside the action: a failed send rolls back and leaves a denied `error` row instead of a success that never reached the student.
    await sendEmail({ to: u.email, ...paymentReceiptEmail({ userName: u.name ?? 'estudante', receiptUrl }) });
  } catch (e) {
    c.get('log').error('receipt not sent', { paymentId: p.id, error: e instanceof Error ? e.message : String(e) });
    return err('internal', 'receipt not sent');
  }
  audit.after({ sentTo: 'account_email' }); // never the address itself
  return ok({});
});

registerExport('payments', async (filters, tx) => {
  const q = parseWith(adminPaymentListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const { items } = await listPayments(q.data, { period: periodOf(filters), all: EXPORT_MAX_ROWS, tx });
  return ok({
    header: ['id', 'quando', 'usuario', 'email', 'item', 'metodo', 'cupom', 'status', 'valor_centavos', 'moeda'],
    rows: items.map((p) => [p.id, p.createdAt, p.user?.name, p.user?.email, p.item, p.method, p.coupon, p.status, p.amountCents, p.currency]),
  });
});

export const paymentsRoutes = new Hono<AdminEnv>()
  .get('/', async (c) => {
    const q = parseWith(adminPaymentListQuerySchema, c.req.query());
    return send(q.ok ? ok(await listPayments(q.data, { period: periodOf(c.req.query()) })) : q);
  })
  .get('/:id', async (c) => {
    const p = await getPayment(c.req.param('id'));
    return send(p ? ok(p) : err('not_found', 'payment not found'));
  })
  .post('/:id/refund', refund)
  .post('/:id/mark-paid', markPaid)
  .post('/:id/resend-receipt', resendReceipt);
