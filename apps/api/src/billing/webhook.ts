import { z } from 'zod';
import { billingPeriods, subscriptionStatuses, type CheckoutInput } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { and, eq, ne } from 'drizzle-orm';
import { dbm } from '../db';
import { applyPendingCredits } from './credits';
import { mirrorPayment, releasedByAdmin, type PaidNotice } from '../admin/payments/mirror';
import { convertGrantsToCredits, lockGrants, monthCents } from './grants';
import { grantChain } from './plan';
import { notifyPurchase } from './purchase-notice';
import { addPeriod, type StripePort } from './stripe';

export type StripeEventLike = { id: string; type: string; data: { object: unknown } };

const session = z.object({
  mode: z.enum(['payment', 'subscription']),
  payment_status: z.string().optional(),
  client_reference_id: z.string().uuid(),
  customer: z.string(),
  subscription: z.string().nullish(),
  // `metadata.userId` is set only by our checkout (stripe.ts); a Payment Link can put ?client_reference_id= in its URL but cannot set metadata (G05 A1).
  metadata: z.object({ period: z.enum(billingPeriods), userId: z.string().uuid() }).partial().optional(),
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
  // D-375: subscription events never touch a Founder row (lifetime outranks any leftover Pro subscription).
  const bySub = (id: string) => and(eq(subscriptions.stripeSubscriptionId, id), ne(subscriptions.plan, 'founder'));

  // Network before the transaction: card checkouts need the live subscription period.
  let write: ((tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>) | null = null;
  let creditsFor: string | null = null; // F18: user whose pending credits are pushed to Stripe after commit
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const parsed = session.safeParse(o);
      // Not one of ours (no user reference, e.g. a dashboard payment link): ignore instead of a 500 retry loop.
      if (!parsed.success) { log.warn('checkout session without a valid user reference ignored'); break; }
      const s = parsed.data;
      if (s.metadata?.userId !== s.client_reference_id) { log.warn('checkout session not created by our checkout ignored', { sessionUser: s.client_reference_id }); break; }
      // `no_payment_required` = fully covered by a coupon (G05 M1); `unpaid` = Pix still pending.
      if (s.payment_status && s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') break;
      const period: CheckoutInput['period'] = s.metadata?.period ?? 'monthly';
      const [cur] = await db.select().from(subscriptions).where(eq(subscriptions.userId, s.client_reference_id));
      if (period === 'lifetime') {
        const userId = s.client_reference_id;
        // D-375 Founder: forever, no renewal. A live Pro card subscription is canceled now (nothing left to pay for); if that
        // fails the student still gets Founder (they paid) and the error is logged for a manual cancel + refund.
        if (cur?.stripeSubscriptionId && cur.status !== 'canceled')
          await stripe.cancelNow(cur.stripeSubscriptionId).catch((e: unknown) => log.error('founder: pro subscription not canceled', { userId, subscriptionId: cur.stripeSubscriptionId, error: String(e) }));
        const row = { plan: 'founder' as const, status: 'active' as const, stripeCustomerId: s.customer, stripeSubscriptionId: null, renewsAt: null, cancelAtPeriodEnd: false };
        write = (tx) => tx.insert(subscriptions).values({ userId, ...row }).onConflictDoUpdate({ target: subscriptions.userId, set: { ...row, updatedAt: new Date() } });
        log.info('founder_purchased', { userId });
        break;
      }
      // A Pro payment landing on a Founder (e.g. a Pix paid late) must not downgrade it.
      if (cur?.plan === 'founder') { log.warn('pro checkout on a founder ignored', { userId: s.client_reference_id }); break; }
      const info = s.mode === 'subscription' ? await stripe.subscription(s.subscription!) : null;
      // Pix: Pro until expiry, no auto-renew (D-101). Buying again while a Pix period runs extends it instead of losing the remaining days.
      // F18 (D-410): a Pix bought during free referral months starts when they end (Pix can't use a Stripe balance credit).
      // P-199: the chain is read inside the transaction, under lockGrants, so a referral qualifying at the same instant can't overlap the Pix period.
      const pixLeft = (grantsUntil: Date | null) => new Date(Math.max(Date.now(), !info && cur && !cur.stripeSubscriptionId && cur.renewsAt ? cur.renewsAt.getTime() : 0, grantsUntil?.getTime() ?? 0));
      const base = { plan: 'pro' as const, status: 'active' as const, stripeCustomerId: s.customer, stripeSubscriptionId: s.subscription ?? null, cancelAtPeriodEnd: info?.cancelAtPeriodEnd ?? true };
      // F18 (D-410): card subscription during free referral months → the months left become balance credit.
      const perMonth = info ? await monthCents(stripe, s.subscription!).catch((e: unknown) => (log.warn('referral grants kept: cannot price credit', { error: String(e) }), null)) : null;
      const userId = s.client_reference_id;
      write = async (tx) => {
        if (!info) await lockGrants(tx, userId);
        const row = { ...base, renewsAt: info?.renewsAt ?? addPeriod(pixLeft((await grantChain(userId, new Date(), tx)).until), period) };
        await tx.insert(subscriptions).values({ userId, ...row }).onConflictDoUpdate({ target: subscriptions.userId, set: { ...row, updatedAt: new Date() } });
        if (perMonth) await convertGrantsToCredits(tx, userId, perMonth);
      };
      if (perMonth) creditsFor = userId;
      log.info('subscription_started', { userId: s.client_reference_id, method: s.mode === 'payment' ? 'pix' : 'card', period });
      break;
    }
    case 'invoice.paid': {
      const i = invoice.parse(o);
      const id = i.subscription ?? i.parent?.subscription_details?.subscription;
      // Proration invoices (switch to annual) list the old period's credit first: the newest period end wins (G05 M2).
      const end = i.lines?.data.length ? Math.max(...i.lines.data.map((l) => l.period.end)) : undefined;
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
      if (next.cancelAtPeriodEnd) {
        log.info('subscription_canceled', { subscriptionId: s.id });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const id = z.object({ id: z.string() }).parse(o).id;
      write = (tx) => tx.update(subscriptions).set({ plan: 'free', status: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() }).where(bySub(id));
      break;
    }
  }
  // F19 T4 (D-456): payments mirror in the same dedupe + transaction; a Pix already released by "marcar como pago" is not released twice.
  // The check runs in the transaction under the payment row lock (D-475): a mark-paid in flight holds that lock, so a Pix
  // confirmation arriving at the same instant waits for it and then sees `marked_paid` instead of extending the plan again.
  const released = { released: write !== null };
  const paid: { notice: PaidNotice | null } = { notice: null };
  const mirror = await mirrorPayment(event, released);
  if (!write && !mirror) return 'ignored';
  const fn = write;
  const result = await db.transaction(async (tx) => {
    const fresh = await tx.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeEvents.id });
    if (!fresh.length) return 'duplicate' as const;
    if (fn && (await releasedByAdmin(event, tx))) released.released = false;
    else await fn?.(tx);
    paid.notice = (await mirror?.(tx)) ?? null; // F19 T4
    return 'applied' as const;
  });
  // After commit; failures stay pending for the daily sweep and never fail the webhook.
  if (result === 'applied' && creditsFor) await applyPendingCredits(creditsFor, stripe);
  if (result === 'applied' && paid.notice) await notifyPurchase(paid.notice); // G18: one per payment, renewals included; never throws
  return result;
}
