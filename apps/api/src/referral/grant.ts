// F18 FR-18: both sides in the caller's transaction. Any throw rolls back the status change and the other side's grant;
// the unique (referral_id, user_id) index makes a replay a no-op even if the status guard were bypassed.
import type { Tx } from '@remoa/db';
import { grantReferralMonth } from '../billing/grants';

/** T4 (billing/grants.ts): Pro month (chained) or, for a renewing card subscriber, a pending `billing_credits` row. */
export type GrantFn = (tx: Tx, a: { userId: string; referralId: string }) => Promise<{ kind: 'month' | 'credit'; created: boolean }>;
export type Granted = { side: 'referrer' | 'referee'; userId: string; kind: 'month' | 'credit' };

export async function grantBothSides(tx: Tx, r: { id: string; referrerId: string; refereeId: string }, grant: GrantFn = grantReferralMonth): Promise<Granted[]> {
  const out: Granted[] = [];
  for (const [side, userId] of [['referrer', r.referrerId], ['referee', r.refereeId]] as const) {
    const g = await grant(tx, { userId, referralId: r.id });
    if (g.created) out.push({ side, userId, kind: g.kind });
  }
  return out;
}
