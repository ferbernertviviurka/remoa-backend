import { eq, sql } from 'drizzle-orm';
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
  const [s] = await db.select().from(t).where(eq(t.userId, userId));
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
  const paid = await paidPlanOf(userId, now);
  if (paid.plan !== 'free') return { ...paid, grantUntil: null };
  const g = await grantChain(userId, now);
  return g.active ? { ...paid, plan: 'pro' as const, grantUntil: g.until } : { ...paid, grantUntil: null };
}
