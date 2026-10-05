import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { err, ok, type UnsubscribeReminder } from '@remoa/contracts';
import { dbm, run } from '../db';
import { dayWindow, dueByOffset } from '../review/queue';
import { reminderEmail } from './email-copy';
import { sendEmail } from './mailer';
import { recordEvent } from './events';

const log = createLogger({ requestId: 'job-reminders' });
const secret = () => {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s) throw new Error('missing env UNSUBSCRIBE_SECRET');
  return s;
};
const mac = (id: string) => createHmac('sha256', secret()).update(id).digest('base64url');

/** `userId.hmac`: no expiry on purpose, an old e-mail must still unsubscribe (the only effect is turning the reminder off). */
export const unsubscribeToken = (userId: string) => `${userId}.${mac(userId)}`;
/** P-192 (D-487): the invitee has no account, the subject is the D-386 e-mail hash (64 hex). Same secret, same format. */
export const inviteeUnsubscribeToken = (emailHash: string) => `${emailHash}.${mac(emailHash)}`;
export const isValidUnsubscribeToken = (token: string) => userOfToken(token) !== null;
const userOfToken = (token: string) => {
  const [id = '', sig = ''] = token.split('.');
  const want = Buffer.from(mac(id));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
};

export const unsubscribeReminder: UnsubscribeReminder = async (token) => {
  const userId = userOfToken(token);
  if (userId && /^[0-9a-f]{64}$/.test(userId)) {
    const { db } = await dbm();
    await db.execute(sql`insert into email_suppressions (email_hash) values (${userId}) on conflict do nothing`);
    return ok(null);
  }
  if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) return err('validation', 'invalid token');
  const { db } = await dbm();
  const r = await db.execute(sql`update user_preferences set reminder_enabled = false, updated_at = now() where user_id = ${userId}`);
  if (r.count) await recordEvent(db, userId, 'reminder_unsubscribed');
  return ok(null);
};

type Candidate = { user_id: string; name: string | null; email: string; local_day: string };

/**
 * FR-15: one e-mail per user per local day, at their chosen local hour, only with items due (same rule as the queue) and no review yet today.
 * Called hourly by `job:maintenance`. Users never get two (reminder_last_sent_on, written by the server connection).
 */
export async function sendDailyReminders(now: Date): Promise<number> {
  const { db } = await dbm();
  const api = process.env.API_ORIGIN ?? `http://localhost:${process.env.PORT ?? 4000}`;
  const web = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const list = await db.execute<Candidate>(sql`
    select p.user_id, p.name, u.email, to_char(${now.toISOString()}::timestamptz at time zone p.timezone, 'YYYY-MM-DD') as local_day
    from user_preferences up
    join profiles p on p.user_id = up.user_id
    join auth.users u on u.id = up.user_id
    where up.reminder_enabled and up.email_review_reminders and p.deleted_at is null and u.email is not null
      and p.timezone in (select name from pg_timezone_names)
      and up.reminder_hour = extract(hour from (${now.toISOString()}::timestamptz at time zone p.timezone))
      and up.reminder_last_sent_on is distinct from (${now.toISOString()}::timestamptz at time zone p.timezone)::date`);
  let sent = 0;
  for (const c of list) {
    try {
      const { due, reviewed } = await run(c.user_id, async (tx) => {
        const win = await dayWindow(tx, c.user_id, now);
        const [n] = await dueByOffset(tx, c.user_id, win, 1);
        const [a] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from attempts where user_id = ${c.user_id} and created_at >= to_timestamp(${win.startMs / 1000})`);
        return { due: n ?? 0, reviewed: (a?.n ?? 0) > 0 };
      });
      if (!due || reviewed) continue;
      const mail = reminderEmail({ name: c.name?.split(' ')[0] ?? 'estudante', n: due, reviewUrl: `${web}/app/revisar`, unsubscribeUrl: `${api}/v1/public/unsubscribe?token=${unsubscribeToken(c.user_id)}` });
      const unsub = `${api}/v1/public/unsubscribe?token=${unsubscribeToken(c.user_id)}`;
      // RFC 8058 one-click: mail clients POST to the URL, the body link opens the confirm page.
      await sendEmail({ to: c.email, ...mail, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
      await db.execute(sql`update user_preferences set reminder_last_sent_on = ${c.local_day}::date where user_id = ${c.user_id}`);
      sent++;
    } catch (e) {
      log.error('reminder failed', { userId: c.user_id, error: e instanceof Error ? e.message : String(e) }); // one bad user must not stop the rest
    }
  }
  return sent;
}
