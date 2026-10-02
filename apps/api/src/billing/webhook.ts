import { z } from 'zod';
import { subscriptionStatuses, type CheckoutInput } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { eq } from 'drizzle-orm';
import { dbm } from '../db';
import { addPeriod, type StripePort } from './stripe';

export type StripeEventLike = { id: string; type: string; data: { object: unknown } };

const session = z.object({
  mode: z.enum(['payment', 'subscription']),
  payment_status: z.string().optional(),
  client_reference_id: z.string().uuid(),
  customer: z.string(),
  subscription: z.string().nullish(),
  metadata: z.object({ period: z.enum(['monthly', 'annual']) }).partial().optional(),
});
// API >= 2025-03-31 (basil; SDK pins 2026-09-30) moved invoice.subscription to parent.subscription_details.subscription.
const invoice = z.object({ subscription: z.string().nullish(), parent: z.object({ subscription_details: z.object({ subscription: z.string().nullish() }).nullish() }).nullish(), lines: z.object({ data: z.array(z.object({ period: z.object({ end: z.number() }) })).min(1) }).optional() });
const sub = z.object({ id: z.string(), status: z.string(), cancel_at_period_end: z.boolean(), items: z.object({ data: z.array(z.object({ current_period_end: z.number() })).min(1) }) });
const status = (s: string) => (subscriptionStatuses as readonly string[]).includes(s) ? (s as (typeof subscriptionStatuses)[number]) : 'incomplete';

/** F08 FR-2: apply one Stripe event exactly once (stripe_events insert + subscription write in one transaction). Unknown types are ignored. */
export async function applyStripeEvent(event: StripeEventLike, stripe: StripePort): Promise<'applied' | 'duplicate' | 'ignored'> {
  const log = createLogger({ requestId: event.id });
  const { db, stripeEvents, subscriptions } = await dbm();
  const o = event.data.object;
  const bySub = (id: string) => eq(subscriptions.stripeSubscriptionId, id);

  // Network before the transaction: card checkouts need the live subscription period.
  let write: ((tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) | null = null;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const parsed = session.safeParse(o);
      // Not one of ours (no user reference, e.g. a dashboard payment link): ignore instead of a 500 retry loop.
      if (!parsed.success) { log.warn('checkout session without a valid user reference ignored'); break; }
      const s = parsed.data;
      if (s.payment_status && s.payment_status !== 'paid') break;
      const info = s.mode === 'subscription' ? await stripe.subscription(s.subscription!) : null;
      const period: CheckoutInput['period'] = s.metadata?.period ?? 'monthly';
      // Pix: Pro until expiry, no auto-renew (D-101). Buying again while a Pix period runs extends it instead of losing the remaining days.
      const [cur] = info ? [] : await db.select().from(subscriptions).where(eq(subscriptions.userId, s.client_reference_id));
      const pixLeft = cur && !cur.stripeSubscriptionId && cur.renewsAt && cur.renewsAt > new Date() ? cur.renewsAt : new Date();
      const renewsAt = info?.renewsAt ?? addPeriod(pixLeft, period);
      const row = { plan: 'pro' as const, status: 'active' as const, stripeCustomerId: s.customer, stripeSubscriptionId: s.subscription ?? null, renewsAt, cancelAtPeriodEnd: info?.cancelAtPeriodEnd ?? true };
      write = (tx) => tx.insert(subscriptions).values({ userId: s.client_reference_id, ...row }).onConflictDoUpdate({ target: subscriptions.userId, set: { ...row, updatedAt: new Date() } });
      log.info('subscription_started', { userId: s.client_reference_id, method: s.mode === 'payment' ? 'pix' : 'card', period });
      break;
    }
    case 'invoice.paid': {
      const i = invoice.parse(o);
      const id = i.subscription ?? i.parent?.subscription_details?.subscription;
      const end = i.lines?.data[0]?.period.end;
      if (id && end) write = (tx) => tx.update(subscriptions).set({ status: 'active', renewsAt: new Date(end * 1000), updatedAt: new Date() }).where(bySub(id));
      break;
    }
    case 'invoice.payment_failed': {
      const i = invoice.parse(o);
      const id = i.subscription ?? i.parent?.subscription_details?.subscription;
      if (id) write = (tx) => tx.update(subscriptions).set({ status: 'past_due', updatedAt: new Date() }).where(bySub(id));
      break;
    }
    case 'customer.subscription.updated': {
      const s = sub.parse(o);
      // Stripe doesn't order events: re-read the live subscription so a late, stale update can't overwrite newer state.
      const live = await stripe.subscription(s.id).catch(() => null);
      const next = live ?? { status: s.status, cancelAtPeriodEnd: s.cancel_at_period_end, renewsAt: new Date(s.items.data[0]!.current_period_end * 1000) };
      write = (tx) => tx.update(subscriptions).set({ status: status(next.status), cancelAtPeriodEnd: next.cancelAtPeriodEnd, renewsAt: next.renewsAt, updatedAt: new Date() }).where(bySub(s.id));
      if (next.cancelAtPeriodEnd) log.info('subscription_canceled', { subscriptionId: s.id });
      break;
    }
    case 'customer.subscription.deleted': {
      const id = z.object({ id: z.string() }).parse(o).id;
      write = (tx) => tx.update(subscriptions).set({ plan: 'free', status: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() }).where(bySub(id));
      break;
    }
  }
  if (!write) return 'ignored';
  const fn = write;
  return db.transaction(async (tx) => {
    const fresh = await tx.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeEvents.id });
    if (!fresh.length) return 'duplicate';
    await fn(tx);
    return 'applied';
  });
}
