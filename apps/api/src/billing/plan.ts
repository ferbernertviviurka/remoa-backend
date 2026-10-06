import { eq, sql } from 'drizzle-orm';
import { pick } from '../pick';
import { PRO_GRACE_DAYS } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../db';

const DAY_MS = 86_400_000;

type SubRow = { plan: string; status: string; stripeSubscriptionId: string | null; renewsAt: Date | null; cancelAtPeriodEnd: boolean };

/** F08 FR-6: does this subscriptions row give Pro right now? Pure, shared with the F18 grant decision (grants.ts). */
export function subscriptionPro(s: SubRow | undefined, now: Date) {
  const renews = s?.renewsAt ?? null;
  const graceUntil = s?.status === 'past_due' && renews ? new Date(renews.getTime() + PRO_GRACE_DAYS * DAY_MS) : null;
  // Pix (D-100) has no Stripe subscription, so nothing ever moves it off 'active': it lapses at renews_at.
  const lapsed = !s?.stripeSubscriptionId && renews !== null && now >= renews;
  const pro =
    s?.plan === 'pro' &&
    (((s.status === 'active' || s.status === 'trialing') && !lapsed) ||
      (graceUntil !== null && now < graceUntil) ||
      (s.cancelAtPeriodEnd && renews !== null && now < renews));
  return { pro: !!pro, graceUntil: pro ? graceUntil : null };
}

/** F08: the plan the subscriptions row alone gives (what Stripe is charging for). F15 summary/switch use this. */
export async function paidPlanOf(userId: string, now = new Date()) {
  const { db, subscriptions: t } = await dbm();
  const [s] = await db.select(pick(t, 'plan', 'status', 'stripeSubscriptionId', 'renewsAt', 'cancelAtPeriodEnd')).from(t).where(eq(t.userId, userId));
  return paidFrom(s, now);
}

type Sub = typeof import('@remoa/db').subscriptions.$inferSelect;
function paidFrom(s: Pick<Sub, 'plan' | 'status' | 'stripeSubscriptionId' | 'renewsAt' | 'cancelAtPeriodEnd'> | undefined, now: Date) {
  // D-375: Founder is lifetime: no renewal, grace or lapse; only a manual change of the row takes it away.
  if (s?.plan === 'founder') return { plan: 'founder' as const, status: s.status, renewsAt: null, cancelAtPeriodEnd: false, graceUntil: null };
  const { pro, graceUntil } = subscriptionPro(s, now);
  return {
    plan: pro ? ('pro' as const) : ('free' as const),
    status: s?.status ?? null,
    renewsAt: s?.renewsAt ?? null,
    cancelAtPeriodEnd: s?.cancelAtPeriodEnd ?? false,
    graceUntil,
  };
}

/** Last instant of the user's non-revoked grant chain still ahead of `now`, and whether one is running now (D-381). Pass `tx` to read it under `lockGrants`. */
export async function grantChain(userId: string, now = new Date(), tx?: Tx) {
  const db = tx ?? (await dbm()).db;
  const at = now.toISOString();
  const [r] = await db.execute<{ until: string | null; active: boolean | null }>(sql`
    select max(ends_at) as until, bool_or(starts_at <= ${at}::timestamptz) as active
    from entitlement_grants where user_id = ${userId} and revoked_at is null and ends_at > ${at}::timestamptz`);
  return { until: r?.until ? new Date(r.until) : null, active: !!r?.active };
}

/**
 * F08 FR-6 + F18 (D-381): the plan in force. Pro when the subscription gives Pro, or else a non-revoked grant with
 * starts_at <= now < ends_at. `grantUntil` = end of the chain, only when the Pro comes from grants. Server connection.
 * Grants end on their own: past ends_at the user is back on Free, nothing is deleted (FR-22).
 */
export async function planOf(userId: string, now = new Date()) {
  // G21 P-482 (D-1046): the subscriptions row and the grant chain (same SQL as grantChain) in ONE statement; was two round trips for Free
  const { db } = await dbm();
  const at = now.toISOString();
  const [r] = await db.execute<{
    plan: Sub['plan'] | null; status: Sub['status'] | null; stripe_subscription_id: string | null; renews_at: string | null; cancel_at_period_end: boolean | null;
    until: string | null; active: boolean | null;
  }>(sql`
    select s.plan, s.status, s.stripe_subscription_id, s.renews_at, s.cancel_at_period_end, g.until, g.active
    from (select max(ends_at) as until, bool_or(starts_at <= ${at}::timestamptz) as active
      from entitlement_grants where user_id = ${userId} and revoked_at is null and ends_at > ${at}::timestamptz) g
    left join subscriptions s on s.user_id = ${userId}`);
  const sub = r?.plan && r.status
    ? { plan: r.plan, status: r.status, stripeSubscriptionId: r.stripe_subscription_id, renewsAt: r.renews_at ? new Date(r.renews_at) : null, cancelAtPeriodEnd: !!r.cancel_at_period_end }
    : undefined;
  const paid = paidFrom(sub, now);
  if (paid.plan !== 'free') return { ...paid, grantUntil: null };
  return r?.active ? { ...paid, plan: 'pro' as const, grantUntil: r.until ? new Date(r.until) : null } : { ...paid, grantUntil: null };
}
