import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { env } from '@remoa/config';
import { DEFAULT_PREFERENCES, type Notify } from '@remoa/contracts';
import { dbm } from '../db';
import { computeReviewHub } from '../review/hub';

const log = createLogger({ requestId: 'job-reminders' });
// D-763: same key as src/emails/tokens.ts (EMAIL_UNSUBSCRIBE_SECRET, else the legacy UNSUBSCRIBE_SECRET), so links already sent keep working.
const mac = (id: string) => createHmac('sha256', env().emailUnsubscribeSecret).update(id).digest('base64url');

/** `userId.hmac`: no expiry on purpose, an old e-mail must still unsubscribe (the only effect is turning the reminder off). */
export const unsubscribeToken = (userId: string) => `${userId}.${mac(userId)}`;
/** P-192 (D-487): the invitee has no account, the subject is the D-386 e-mail hash (64 hex). Same secret, same format. */
export const inviteeUnsubscribeToken = (emailHash: string) => `${emailHash}.${mac(emailHash)}`;
/** Legacy F13/F18 tokens are verified by emails/tokens.ts verifyUnsubscribeToken and applied by emails/unsubscribe.ts (G18, P-316). */

type Candidate = { user_id: string; name: string | null; local_day: string };

/**
 * F13 FR-15 → G18 F26 (D-781): the daily review reminder goes through notify('review_reminder') (bell on by default, e-mail by the
 * user's preference). Every 15 min (review.reminder): users whose local hour is their reminder hour, with cards due and no review yet
 * that study day, at most one per local day (reminder_last_sent_on + the notify reference).
 */
export async function sendDailyReminders(now: Date, notify: Notify): Promise<number> {
  const { db } = await dbm();
  const at = now.toISOString();
  const list = await db.execute<Candidate>(sql`
    select p.user_id, p.name, to_char(${at}::timestamptz at time zone p.timezone, 'YYYY-MM-DD') as local_day
    from profiles p
    left join user_preferences up on up.user_id = p.user_id
    where p.deleted_at is null and p.suspended_at is null
      and p.timezone in (select name from pg_timezone_names)
      and coalesce(up.reminder_hour, ${DEFAULT_PREFERENCES.reminderHour}) = extract(hour from (${at}::timestamptz at time zone p.timezone))
      and up.reminder_last_sent_on is distinct from (${at}::timestamptz at time zone p.timezone)::date
      and exists (select 1 from fsrs_state f where f.user_id = p.user_id and f.due < ${at}::timestamptz + interval '1 day')
      and not exists (select 1 from notification_preferences n where n.user_id = p.user_id and n.key = 'review_reminder' and not n.in_app and not n.email)`);
  const { appUrl } = env();
  let sent = 0;
  for (const c of list) {
    try {
      const hub = await computeReviewHub(c.user_id, now);
      if (!hub.queue.counts.due || hub.today.reviewed > 0) continue; // same rule as F13: something due, nothing reviewed yet
      const maps = hub.maps
        .map((m) => ({ title: m.title, cards: m.due + m.new }))
        .filter((m) => m.cards > 0)
        .sort((a, b) => b.cards - a.cards)
        .slice(0, 3);
      await notify(c.user_id, 'review_reminder', {
        reference: `${c.user_id}:${c.local_day}`, // e-mail references are global, not per user
        href: '/app/revisar',
        data: { cards: hub.queue.defaultCount },
        email: {
          name: c.name?.trim().split(/\s+/)[0] || null,
          cards: hub.queue.defaultCount,
          overdue: hub.queue.counts.due,
          newCards: hub.queue.counts.new,
          minutes: Math.max(1, Math.round(hub.queue.estimatedSeconds / 60)),
          maps,
          reviewUrl: `${appUrl}/app/revisar`,
        },
      });
      await db.execute(sql`
        insert into user_preferences (user_id, reminder_last_sent_on) values (${c.user_id}, ${c.local_day}::date)
        on conflict (user_id) do update set reminder_last_sent_on = excluded.reminder_last_sent_on`);
      sent++;
    } catch (e) {
      log.error('reminder failed', { userId: c.user_id, error: e instanceof Error ? e.message : String(e) }); // one bad user must not stop the rest
    }
  }
  return sent;
}
