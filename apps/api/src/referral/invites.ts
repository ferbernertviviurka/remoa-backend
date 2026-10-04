import { sql } from 'drizzle-orm';
import { err, ok, REFERRAL_LIMITS, referralErrors, referralLink, type InviteResult, type Result } from '@remoa/contracts';
import type { Logger } from '@remoa/log';
import { sendEmail } from '../account/mailer';
import { dbm } from '../db';
import { emailHash, maskEmail } from './email-normalize';
import { referralInviteEmail } from './email-copy';
import { ensureCode, invitesLeftToday } from './summary';

/** FR-7. `emails` already validated/lowercased by inviteInputSchema. Same answer whether or not an address has an account. */
export async function sendInvites(userId: string, emails: string[], log: Logger): Promise<Result<InviteResult>> {
  const { db } = await dbm();
  const code = await ensureCode(userId);
  const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'invite:' + userId}))`); // concurrent requests cannot both pass the limit
    if ((await invitesLeftToday(userId, tx)) < emails.length) return null;
    const existing = new Set(
      (await tx.execute<{ email: string }>(sql`select lower(email) as email from auth.users where lower(email) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`)).map((r) => r.email),
    );
    const fresh: string[] = [];
    for (const e of emails) {
      const rows = await tx.execute(sql`
        insert into referrals (referrer_id, invited_email_hash, invited_email_masked, channel, status, expires_at)
        values (${userId}, ${emailHash(e)}, ${maskEmail(e)}, 'email', 'invited', now() + make_interval(days => ${REFERRAL_LIMITS.inviteExpiryDays}))
        on conflict do nothing returning id`);
      if (rows.length && !existing.has(e)) fresh.push(e); // re-invite or existing account: recorded/ignored, nothing sent
    }
    const [p] = await tx.execute<{ name: string | null }>(sql`select name from profiles where user_id = ${userId}`);
    return { fresh, name: p?.name?.trim().split(/\s+/)[0] || 'Um amigo', left: await invitesLeftToday(userId, tx) };
  });
  if (!out) return err('rate_limited', referralErrors.dailyLimit);
  // D-399: not awaited. Only addresses without an account get an e-mail, so waiting for the provider would make the response
  // measurably slower for them (timing oracle on who has an account). The row is already committed; a failure only logs.
  for (const to of out.fresh) {
    const mail = referralInviteEmail({ referrerName: out.name, inviteLink: referralLink(origin, code), unsubscribeUrl: `${origin}/regulamento-indicacao` }); // ponytail: P-192 no suppression list yet
    void sendEmail({ to, ...mail }).catch((e: unknown) => log.error('referral invite email failed', { error: e instanceof Error ? e.message : String(e) }));
  }
  log.info('referral_invites_sent', { event: 'referral_invites_sent', count: emails.length });
  return ok({ sent: emails.length, invitesLeftToday: out.left });
}
