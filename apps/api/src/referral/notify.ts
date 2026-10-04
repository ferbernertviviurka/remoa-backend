import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { sendEmail } from '../account/mailer';
import { unsubscribeToken } from '../account/reminders';
import { dbm } from '../db';
import { referralRewardGrantedRefereeEmail, referralRewardGrantedReferrerEmail } from './email-copy';

const log = createLogger({ requestId: 'referral-notify' });
const first = (n: string | null, fallback: string) => n?.trim().split(/\s+/)[0] || fallback;

/** FR-21. Call after the qualification commit. Never throws: a mail failure must not undo or retry a grant. */
export async function notifyRewardGranted(referralId: string): Promise<void> {
  try {
    const { db } = await dbm();
    const [r] = await db.execute<{ referrer_id: string; referee_id: string | null; referrer_email: string | null; referrer_name: string | null; referee_email: string | null; referee_name: string | null }>(sql`
      select r.referrer_id, r.referee_id, ru.email as referrer_email, rp.name as referrer_name, eu.email as referee_email, ep.name as referee_name
      from referrals r
      join auth.users ru on ru.id = r.referrer_id left join profiles rp on rp.user_id = r.referrer_id
      left join auth.users eu on eu.id = r.referee_id left join profiles ep on ep.user_id = r.referee_id
      where r.id = ${referralId} and r.status = 'qualified'`);
    if (!r) return;
    const web = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    const api = process.env.API_ORIGIN ?? `http://localhost:${process.env.PORT ?? 4000}`;
    const unsub = (id: string) => `${api}/v1/public/unsubscribe?token=${unsubscribeToken(id)}`;
    const dashboardUrl = `${web}/app/indicar`;
    const jobs: Promise<void>[] = [];
    if (r.referrer_email)
      jobs.push(sendEmail({ to: r.referrer_email, ...referralRewardGrantedReferrerEmail({ referrerName: first(r.referrer_name, 'estudante'), refereeName: first(r.referee_name, 'Seu amigo'), referrerDashboardUrl: dashboardUrl, unsubscribeUrl: unsub(r.referrer_id) }) }));
    if (r.referee_email && r.referee_id)
      jobs.push(sendEmail({ to: r.referee_email, ...referralRewardGrantedRefereeEmail({ refereeName: first(r.referee_name, 'estudante'), referrerName: first(r.referrer_name, 'seu amigo'), dashboardUrl, unsubscribeUrl: unsub(r.referee_id) }) }));
    for (const x of await Promise.allSettled(jobs)) if (x.status === 'rejected') log.error('reward email failed', { referralId, error: String(x.reason) });
  } catch (e) {
    log.error('notifyRewardGranted failed', { referralId, error: e instanceof Error ? e.message : String(e) });
  }
}
