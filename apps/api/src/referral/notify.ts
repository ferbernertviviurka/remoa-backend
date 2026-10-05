import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { env } from '@remoa/config';
import { notify } from '../notifications/notify';
import { dbm } from '../db';

const log = createLogger({ requestId: 'referral-notify' });
const first = (n: string | null) => n?.trim().split(/\s+/)[0]?.slice(0, 80) || null;

/** FR-21. Call after the qualification commit. Never throws: a mail failure must not undo or retry a grant. */
export async function notifyRewardGranted(referralId: string): Promise<void> {
  try {
    const { db } = await dbm();
    const [r] = await db.execute<{ referrer_id: string; referee_id: string | null; referrer_name: string | null; referee_name: string | null }>(sql`
      select r.referrer_id, r.referee_id, rp.name as referrer_name, ep.name as referee_name
      from referrals r
      left join profiles rp on rp.user_id = r.referrer_id left join profiles ep on ep.user_id = r.referee_id
      where r.id = ${referralId} and r.status = 'qualified'`);
    if (!r) return;
    const dashboardUrl = `${env().appUrl}/app/indicar`;
    const jobs = [
      notify(r.referrer_id, 'referral_reward', {
        reference: `${referralId}:referrer`,
        href: '/app/indicar',
        data: { referralId, role: 'referrer' },
        email: { version: 'referrer', name: first(r.referrer_name), friendName: first(r.referee_name), dashboardUrl },
      }),
    ];
    if (r.referee_id)
      jobs.push(notify(r.referee_id, 'referral_reward', {
        reference: `${referralId}:referee`,
        href: '/app/indicar',
        data: { referralId, role: 'referee' },
        email: { version: 'referee', name: first(r.referee_name), friendName: first(r.referrer_name), dashboardUrl },
      }));
    await Promise.all(jobs);
  } catch (e) {
    log.error('notifyRewardGranted failed', { referralId, error: e instanceof Error ? e.message : String(e) });
  }
}
