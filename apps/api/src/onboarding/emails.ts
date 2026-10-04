import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { sendEmail } from '../account/mailer';
import { claimEmail } from './onboarding';
import { day3Email, mapReadyEmail } from './email-copy';

const log = createLogger({ requestId: 'job-onboarding-emails' });
type Cand = { user_id: string; email: string; name: string | null };

/**
 * F12 FR-8, hourly (idempotent through `_emails` flags, D-525):
 * - mapReady: first time any live board of the user reaches 20 non-note cards;
 * - day3: account 3+ days old, no ended session yet, and the reminder e-mails not turned off.
 */
export async function sendOnboardingEmails(now: Date): Promise<{ mapReady: number; day3: number }> {
  const { db } = await dbm();
  const web = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const base = sql`from profiles p join auth.users u on u.id = p.user_id
    where p.deleted_at is null and u.email is not null and p.created_at > ${now.toISOString()}::timestamptz - interval '30 days'`;
  const mapReady = await db.execute<Cand>(sql`select p.user_id, u.email, p.name ${base}
    and not (coalesce(p.onboarding_answers->'_emails', '{}'::jsonb) ? 'mapReady')
    and exists (select 1 from boards b join cards c on c.board_id = b.id where b.user_id = p.user_id and b.archived_at is null and c.deleted_at is null and c.type <> 'note' group by b.id having count(*) >= 20)`);
  const day3 = await db.execute<Cand>(sql`select p.user_id, u.email, p.name ${base}
    and p.created_at <= ${now.toISOString()}::timestamptz - interval '3 days'
    and not (coalesce(p.onboarding_answers->'_emails', '{}'::jsonb) ? 'day3')
    and not exists (select 1 from sessions s where s.user_id = p.user_id and s.ended_at is not null)
    and coalesce((select up.email_review_reminders from user_preferences up where up.user_id = p.user_id), true)`);
  let m = 0;
  let d = 0;
  for (const [list, key, mail, url] of [[mapReady, 'mapReady', mapReadyEmail, `${web}/app/revisar`], [day3, 'day3', day3Email, `${web}/app`]] as const) {
    for (const c of list) {
      try {
        if (!(await claimEmail(c.user_id, key))) continue;
        await sendEmail({ to: c.email, ...mail({ name: c.name?.split(' ')[0] ?? 'estudante', url }) });
        if (key === 'mapReady') m++;
        else d++;
      } catch (e) {
        log.error('onboarding email failed', { userId: c.user_id, key, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { mapReady: m, day3: d };
}
