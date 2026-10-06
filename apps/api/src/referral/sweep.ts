// F18 FR-22 + D-384 daily sweep (account/maintenance.ts until Inngest): expire stale invites, qualify what the hooks missed.
import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { applyPendingCredits } from '../billing/credits';
import { dbm } from '../db';
import { maybeQualifyReferral } from './qualify';
import { invalidate } from '../cache';

const log = createLogger({ requestId: 'job-referral-sweep' });

export async function sweepReferrals(now = new Date()) {
  const { db } = await dbm();
  const expiredRows = await db.execute<{ referrer_id: string }>(sql`update referrals set status = 'expired' where status = 'invited' and expires_at <= ${now.toISOString()} returning id, referrer_id`);
  const expired = expiredRows.length;
  for (const id of new Set(expiredRows.map((r) => r.referrer_id))) await invalidate('referral.changed', { userId: id });
  // ponytail: sequential over every signed_up row; fine for thousands. Add a `signed_up_at > now - 90 days` cutoff if it grows.
  const pending = await db.execute<{ referee_id: string }>(sql`select referee_id from referrals where status = 'signed_up' and referee_id is not null`);
  let qualified = 0;
  for (const p of pending) if ((await maybeQualifyReferral(p.referee_id, { now, log })) === 'qualified') qualified++;
  const credits = await applyPendingCredits(); // FR-19 retries (T4); pending = Stripe failed earlier
  log.info('referral sweep done', { expired, qualified, checked: pending.length, credits });
  return { expired, qualified, credits };
}
