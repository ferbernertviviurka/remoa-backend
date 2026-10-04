// F19 FR-16 (D-428, D-456, D-457): `payments` mirror, written from the F08 webhook inside its transaction, after the
// stripe_events insert (same dedupe). Never throws on a payload it doesn't understand: the F08 handler must keep working.
import { z } from 'zod';
import { eq, or, sql } from 'drizzle-orm';
import type { PaymentEventType, PaymentItem, PaymentRecordMethod, PaymentStatus } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { createLogger } from '@remoa/log';
import { dbm } from '../../db';
import { writeAudit } from '../core';
import { paymentsPort } from './port';

type Event = { id: string; type: string; created?: number; data: { object: unknown } };
type Mirror = (tx: Tx) => Promise<void>;
type Upsert = {
  id: string; userId: string | null; customer: string | null; subscription: string | null; paymentIntent: string | null; invoice: string | null;
  amountCents: number; method: PaymentRecordMethod; item: PaymentItem; coupon: string | null; status: Exclude<PaymentStatus, 'refunded'>; events: PaymentEventType[];
};

const RANK: Record<PaymentStatus, number> = { pending: 0, failed: 1, paid: 2, refunded: 3 };
const idOf = z.union([z.string(), z.object({ id: z.string() })]).transform((v) => (typeof v === 'string' ? v : v.id));
const session = z.object({
  mode: z.literal('payment'),
  payment_status: z.string(),
  client_reference_id: z.string().uuid(),
  customer: z.string(),
  payment_intent: idOf,
  amount_total: z.number().int().nonnegative(),
  metadata: z.object({ userId: z.string().uuid(), period: z.string().optional(), method: z.string().optional(), coupon: z.string().optional() }),
  discounts: z.array(z.object({ coupon: idOf.nullish(), promotion_code: idOf.nullish() })).nullish(),
});
const invoice = z.object({
  id: z.string(),
  customer: idOf,
  amount_paid: z.number().int(),
  amount_due: z.number().int(),
  billing_reason: z.string().nullish(),
  starting_balance: z.number().int().nullish(),
  subscription: z.string().nullish(),
  parent: z.object({ subscription_details: z.object({ subscription: z.string().nullish() }).nullish() }).nullish(),
  lines: z.object({ data: z.array(z.object({ period: z.object({ start: z.number(), end: z.number() }) })).min(1) }),
});
const charge = z.object({ payment_intent: idOf, refunded: z.literal(true), refunds: z.object({ data: z.array(z.object({ status: z.string().nullish() })) }).nullish() });
const refund = z.object({ payment_intent: idOf, status: z.literal('succeeded'), amount: z.number().int() });

const itemOf = (period: string | undefined): PaymentItem => (period === 'lifetime' ? 'founder_lifetime' : period === 'annual' ? 'pro_annual' : 'pro_monthly');

/** Builds the transaction step for `event`, or null when it is not a payment event of ours. Network (invoice → PaymentIntent) happens here, before the transaction. */
export async function mirrorPayment(event: Event, opts: { released: boolean }): Promise<Mirror | null> {
  const log = createLogger({ requestId: event.id });
  const at = new Date((event.created ?? Date.now() / 1000) * 1000).toISOString();
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const p = session.safeParse(o);
      // Same "ours" rule as F08: metadata.userId only comes from our checkout. Card subscriptions are mirrored from invoices.
      if (!p.success || p.data.metadata.userId !== p.data.client_reference_id) return null;
      const s = p.data;
      const method = s.metadata.method === 'card' ? 'card' : 'pix';
      const step: PaymentEventType = method === 'pix' ? 'pix_generated' : 'card_authorized';
      const failed = event.type === 'checkout.session.async_payment_failed';
      const paid = !failed && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
      const d = s.discounts?.[0];
      return (tx) => upsert(tx, at, {
        id: s.payment_intent, userId: s.client_reference_id, customer: s.customer, subscription: null, paymentIntent: s.payment_intent, invoice: null,
        amountCents: s.amount_total, method, item: itemOf(s.metadata.period), coupon: s.metadata.coupon ?? d?.promotion_code ?? d?.coupon ?? null,
        status: failed ? 'failed' : paid ? 'paid' : 'pending',
        events: ['checkout_created', step, ...(failed ? ['failed' as const] : paid ? ['paid' as const, ...(opts.released ? ['plan_released' as const] : [])] : [])],
      });
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const p = invoice.safeParse(o);
      const sub = p.success ? (p.data.subscription ?? p.data.parent?.subscription_details?.subscription) : null;
      if (!p.success || !sub) return null;
      const i = p.data;
      // A configured port that fails throws: the webhook answers 500 and Stripe retries (as F08 does with stripe.subscription).
      const port = paymentsPort();
      const pi = port ? await port.invoicePayment(i.id) : null;
      const paid = event.type === 'invoice.paid';
      const longest = i.lines.data.reduce((a, l) => (l.period.end > a.period.end ? l : a));
      return async (tx) => {
        const { subscriptions: s } = await dbm();
        const [owner] = await tx.select({ userId: s.userId }).from(s).where(or(eq(s.stripeSubscriptionId, sub), eq(s.stripeCustomerId, i.customer))).limit(1);
        await upsert(tx, at, {
          id: pi ?? i.id, userId: owner?.userId ?? null, customer: i.customer, subscription: sub, paymentIntent: pi, invoice: i.id,
          amountCents: paid ? i.amount_paid : i.amount_due,
          method: !pi && paid && i.amount_paid === 0 && (i.starting_balance ?? 0) < 0 ? 'credit' : 'card',
          item: longest.period.end - longest.period.start > 60 * 86_400 ? 'pro_annual' : 'pro_monthly',
          coupon: null, status: paid ? 'paid' : 'failed',
          events: [...(i.billing_reason === 'subscription_create' ? ['checkout_created' as const] : []), ...(paid ? ['card_authorized', 'paid', ...(opts.released ? ['plan_released'] : [])] as PaymentEventType[] : ['failed' as const])],
        });
      };
    }
    case 'charge.refunded': {
      const p = charge.safeParse(o);
      // A pending refund (Pix refunds are async) waits for refund.updated.
      if (!p.success || p.data.refunds?.data.some((r) => r.status !== 'succeeded')) return null;
      return (tx) => refunded(tx, at, p.data.payment_intent, null, event);
    }
    case 'refund.created':
    case 'refund.updated': {
      const p = refund.safeParse(o);
      if (!p.success) return null;
      return (tx) => refunded(tx, at, p.data.payment_intent, p.data.amount, event);
    }
  }
  if (event.type.startsWith('refund.') || event.type.startsWith('charge.')) log.info('payment event not mirrored', { type: event.type });
  return null;
}

const merge = (cur: { type: PaymentEventType; at: string }[], add: PaymentEventType[], at: string) =>
  [...cur, ...add.filter((t) => !cur.some((e) => e.type === t)).map((type) => ({ type, at }))];

/** Insert or merge: status only moves forward (late or out-of-order events never undo a payment), timeline types are kept once. */
async function upsert(tx: Tx, at: string, u: Upsert) {
  const { payments: t } = await dbm();
  const row = {
    id: u.id, userId: u.userId, stripeCustomerId: u.customer, stripeSubscriptionId: u.subscription, stripePaymentIntent: u.paymentIntent, stripeInvoiceId: u.invoice,
    amountCents: u.amountCents, method: u.method, item: u.item, coupon: u.coupon, status: u.status, events: merge([], u.events, at),
  };
  const fresh = await tx.insert(t).values(row).onConflictDoNothing().returning({ id: t.id });
  if (fresh.length) return;
  const [cur] = await tx.select().from(t).where(eq(t.id, u.id)).for('update');
  if (!cur) return;
  const forward = RANK[u.status] > RANK[cur.status];
  await tx.update(t).set({
    status: forward ? u.status : cur.status,
    amountCents: forward && u.status === 'paid' ? u.amountCents : cur.amountCents,
    events: merge(cur.events, u.events, at),
    userId: cur.userId ?? u.userId, coupon: cur.coupon ?? u.coupon,
    stripePaymentIntent: cur.stripePaymentIntent ?? u.paymentIntent, stripeInvoiceId: cur.stripeInvoiceId ?? u.invoice,
    stripeSubscriptionId: cur.stripeSubscriptionId ?? u.subscription, stripeCustomerId: cur.stripeCustomerId ?? u.customer,
    updatedAt: new Date(),
  }).where(eq(t.id, u.id));
}

/**
 * Stripe confirmed a full refund: status → refunded (the only path, D-428), one `payment.webhook` audit row, and the plan
 * is reviewed (D-457): Pix Pro loses the refunded period, Founder goes back to Free, a card subscription is left to its
 * own Stripe lifecycle (a refund there is usually a duplicate charge; cancel = customer.subscription.deleted).
 */
async function refunded(tx: Tx, at: string, pi: string, amount: number | null, event: Event) {
  const { payments: t, subscriptions: s } = await dbm();
  const [p] = await tx.select().from(t).where(or(eq(t.id, pi), eq(t.stripePaymentIntent, pi))).limit(1).for('update');
  if (!p || p.status === 'refunded' || (amount !== null && amount < p.amountCents)) return; // unknown, done, or partial (P2)
  await tx.update(t).set({ status: 'refunded', refundedAt: new Date(at), events: merge(p.events, ['refunded'], at), updatedAt: new Date() }).where(eq(t.id, p.id));
  let plan = 'kept';
  if (p.userId && p.item === 'founder_lifetime') {
    const r = await tx.update(s).set({ plan: 'free', status: 'canceled', renewsAt: null, cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(sql`${s.userId} = ${p.userId} and ${s.plan} = 'founder'`).returning({ u: s.userId });
    if (r.length) plan = 'founder_revoked';
  } else if (p.userId && p.method === 'pix') {
    // ponytail: `- interval` is not addPeriod's day clamp (Jan 31 + 1 month - 1 month = Jan 28); a few days at most.
    const span = p.item === 'pro_annual' ? sql`interval '1 year'` : sql`interval '1 month'`;
    const r = await tx.update(s).set({ renewsAt: sql`${s.renewsAt} - ${span}`, updatedAt: new Date() })
      .where(sql`${s.userId} = ${p.userId} and ${s.plan} = 'pro' and ${s.stripeSubscriptionId} is null and ${s.renewsAt} is not null`).returning({ u: s.userId });
    if (r.length) plan = 'pix_period_removed';
  }
  await writeAudit({
    actorType: 'stripe', actorId: null, action: 'payment.webhook', targetType: 'payment', targetId: p.id, reason: `Stripe ${event.type}`,
    result: 'success', before: { status: p.status }, after: { status: 'refunded', plan }, requestId: event.id,
  }, tx);
}

/** The payment behind this paid checkout event was already released by "marcar como pago": F08 must not extend the plan twice. */
/** Locks the payment row (in the webhook's transaction): waits for a mark-paid in flight, which holds the same lock. */
export async function releasedByAdmin(event: Event, tx: Tx): Promise<boolean> {
  if (!event.type.startsWith('checkout.session.')) return false;
  const p = session.safeParse(event.data.object);
  if (!p.success) return false;
  const { payments: t } = await dbm();
  const [row] = await tx.select({ events: t.events }).from(t).where(eq(t.id, p.data.payment_intent)).for('update');
  return !!row?.events.some((e) => e.type === 'marked_paid');
}
