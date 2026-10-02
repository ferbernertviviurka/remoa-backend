import { eq } from 'drizzle-orm';
import { PRO_GRACE_DAYS } from '@remoa/contracts';
import { dbm } from '../db';

const DAY_MS = 86_400_000;

/** F08 FR-6: the plan actually in force, from the subscriptions row. No row / lapsed = free. Server connection. */
export async function planOf(userId: string, now = new Date()) {
  const { db, subscriptions: t } = await dbm();
  const [s] = await db.select().from(t).where(eq(t.userId, userId));
  const renews = s?.renewsAt ?? null;
  const graceUntil = s?.status === 'past_due' && renews ? new Date(renews.getTime() + PRO_GRACE_DAYS * DAY_MS) : null;
  // Pix (D-100) has no Stripe subscription, so nothing ever moves it off 'active': it lapses at renews_at.
  const lapsed = !s?.stripeSubscriptionId && renews !== null && now >= renews;
  const pro =
    s?.plan === 'pro' &&
    (((s.status === 'active' || s.status === 'trialing') && !lapsed) ||
      (graceUntil !== null && now < graceUntil) ||
      (s.cancelAtPeriodEnd && renews !== null && now < renews));
  return {
    plan: pro ? ('pro' as const) : ('free' as const),
    status: s?.status ?? null,
    renewsAt: renews,
    cancelAtPeriodEnd: s?.cancelAtPeriodEnd ?? false,
    graceUntil: pro ? graceUntil : null,
  };
}
