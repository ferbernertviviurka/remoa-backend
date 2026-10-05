// F18 FR-20 antifraud. Hard rules reject at qualification (status `rejected` + reason, no grant); weak signals only flag for review.
import { sql } from 'drizzle-orm';
import { REFERRAL_LIMITS, type ReferralRejectReason } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import type { Logger } from '@remoa/log';
import { normalizeEmail } from './email-normalize';

/**
 * ponytail: small static list of the throwaway domains seen most in BR sign-ups; extend here (no external list/dependency).
 * Unknown throwaway domains still hit the 30-day velocity limit.
 */
export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '20minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getnada.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamailblock.com', 'grr.la', 'sharklasers.com', 'maildrop.cc', 'mailinator.com',
  'mailnesia.com', 'mintemail.com', 'mohmal.com', 'moakt.com', 'mytemp.email', 'nada.email', 'spamgourmet.com', 'temp-mail.org',
  'temp-mail.io', 'tempail.com', 'tempmail.com', 'tempmail.dev', 'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'trashmail.com',
  'yopmail.com', 'yopmail.net', 'emailfake.com', 'tmail.ws', 'tmpmail.org', 'burnermail.io', 'inboxkitten.com', 'mailpoof.com',
]);

export const isDisposable = (email: string) => DISPOSABLE_DOMAINS.has(normalizeEmail(email).split('@')[1] ?? '');

/**
 * Hard checks, in order of severity. Runs inside the qualification transaction; the caller already holds the referrer's
 * velocity lock (`referral-velocity:<referrer>`), so two referees qualifying at once cannot both slip under the limit.
 */
export async function rejectReason(
  tx: Tx,
  r: { referrerId: string; refereeId: string; referrerEmail: string | null; refereeEmail: string | null },
  now: Date,
): Promise<ReferralRejectReason | null> {
  if (r.referrerId === r.refereeId) return 'self_referral';
  if (r.referrerEmail && r.refereeEmail && normalizeEmail(r.referrerEmail) === normalizeEmail(r.refereeEmail)) return 'self_referral';
  if (r.refereeEmail && isDisposable(r.refereeEmail)) return 'disposable_email';
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [q] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from referrals where referrer_id = ${r.referrerId} and status = 'qualified' and qualified_at > ${since.toISOString()}`,
  );
  if ((q?.n ?? 0) >= REFERRAL_LIMITS.qualifiedPer30Days) return 'velocity_limit'; // Q-041: manual review above the limit (P-190)
  return null;
}

// --- weak signals (never block on their own) ----------------------------------------------------------------------
const WINDOW_MS = 60 * 60_000;
const seen = new Map<string, number[]>();
/**
 * Same referrer + same IP + same user agent attributing again within an hour: log `referral_review` for a human.
 * ponytail: in-memory, one API instance (Q-008); move to a table when there is more than one process or an admin queue (P-191).
 */
export function flagWeakSignals(referrerId: string, ip: string, ua: string, log: Logger, now = Date.now()): boolean {
  if (seen.size > 10_000) for (const [k, v] of seen) if (v.every((t) => now - t >= WINDOW_MS)) seen.delete(k);
  const key = `${referrerId}|${ip}|${ua}`;
  const list = (seen.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  seen.set(key, list);
  if (list.length < 2) return false;
  log.warn('referral_review', { event: 'referral_review', referrerId, signal: 'same_ip_ua', count: list.length }); // ids only, no IP/UA
  return true;
}
