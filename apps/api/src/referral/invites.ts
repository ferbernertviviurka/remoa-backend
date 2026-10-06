import { sql } from 'drizzle-orm';
import { err, ok, REFERRAL_LIMITS, referralErrors, referralLink, type InviteResult, type Result } from '@remoa/contracts';
import type { Logger } from '@remoa/log';
import { env } from '@remoa/config';
import { notifyAddress } from '../notifications/notify';
import { dbm } from '../db';
import { emailHash, maskEmail } from './email-normalize';
import { ensureCode, invitesLeftToday } from './summary';
import { invalidate } from '../cache';

/** FR-7. `emails` already validated/lowercased by inviteInputSchema. Same answer whether or not an address has an account. */
export async function sendInvites(userId: string, emails: string[], log: Logger): Promise<Result<InviteResult>> {
  const { db } = await dbm();
  const code = await ensureCode(userId);
  const origin = env().appUrl;
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'invite:' + userId}))`); // concurrent requests cannot both pass the limit
    if ((await invitesLeftToday(userId, tx)) < emails.length) return null;
    const existing = new Set(
      (await tx.execute<{ email: string }>(sql`select lower(email) as email from auth.users where lower(email) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`)).map((r) => r.email),
    );
    const hashes = emails.map(emailHash);
    const suppressed = new Set(
      (await tx.execute<{ email_hash: string }>(sql`select email_hash from email_suppressions where email_hash in (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`)).map((r) => r.email_hash),
    );
    const fresh: { to: string; referralId: string }[] = [];
    for (const e of emails) {
      if (suppressed.has(emailHash(e))) continue; // P-192: same answer, nothing recorded or sent
      const rows = await tx.execute(sql`
        insert into referrals (referrer_id, invited_email_hash, invited_email_masked, channel, status, expires_at)
        values (${userId}, ${emailHash(e)}, ${maskEmail(e)}, 'email', 'invited', now() + make_interval(days => ${REFERRAL_LIMITS.inviteExpiryDays}))
        on conflict do nothing returning id`);
      if (rows[0] && !existing.has(e)) fresh.push({ to: e, referralId: String(rows[0].id) }); // re-invite or existing account: recorded/ignored, nothing sent
    }
    const [p] = await tx.execute<{ name: string | null }>(sql`select name from profiles where user_id = ${userId}`);
    return { fresh, name: p?.name?.trim().split(/\s+/)[0] || 'Um amigo', left: await invitesLeftToday(userId, tx) };
  });
  if (!out) return err('rate_limited', referralErrors.dailyLimit);
  await invalidate('referral.changed', { userId });
  // D-399: not awaited. Only addresses without an account get an e-mail, so waiting for the provider would make the response
  // measurably slower for them (timing oracle on who has an account). The row is already committed; a failure only logs.
  for (const { to, referralId } of out.fresh)
    void notifyAddress(to, 'referral_invite', { reference: referralId, email: { referrerName: out.name, inviteUrl: referralLink(origin, code) } });
  log.info('referral_invites_sent', { event: 'referral_invites_sent', count: emails.length });
  return ok({ sent: emails.length, invitesLeftToday: out.left });
}
