// F25 FR-13/FR-15 + F26 FR-11: send the calendar reminders that are due, one notify() per (user, kind, local day).
// Runs every 5 minutes (calendar.dispatch-reminders); safe to run twice at once (row locks, skip locked) and to retry (notify reference).
import { sql } from 'drizzle-orm';
import { env } from '@remoa/config';
import { createLogger } from '@remoa/log';
import type { CalendarColor, CalendarReminderKind, Notify } from '@remoa/contracts';
import { dbm, run } from '../../db';
import { dayWindow, dueByOffset } from '../../review/queue';
import { coverUrlFor, icsUrlFor } from '../ics';
import { validTz } from './plan';
import { invalidate } from '../../cache';

const log = createLogger({ requestId: 'job-calendar-reminders' });
/** D-779: a reminder more than 3 h late (outage, paused cron) is skipped instead of sent; so is one whose timed event already started. */
export const STALE_HOURS = 3;
const DIGEST_MAX = 20; // calendar-reminder "varios" lists at most 20 events

type Group = { user_id: string; kind: CalendarReminderKind; occurrence_date: string };
type Due = {
  id: string; event_id: string; title: string; starts_at: Date | string; ends_at: Date | string | null; all_day: boolean; location: string | null;
  description: string | null; label_name: string; label_color: CalendarColor; tz: string | null; name: string | null; has_cover: boolean;
};
const iso = (d: Date | string) => new Date(d).toISOString();

async function dueCards(userId: string, now: Date) {
  return run(userId, async (tx) => (await dueByOffset(tx, userId, await dayWindow(tx, userId, now), 1))[0] ?? 0);
}

async function sendGroup(g: Group, now: Date, notify: Notify): Promise<number> {
  const { db } = await dbm();
  const nowIso = now.toISOString();
  return db.transaction(async (tx) => {
    const rows = await tx.execute<Due>(sql`
      select r.id, e.id as event_id, e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.description,
             l.name as label_name, l.color as label_color, p.timezone as tz, p.name, e.cover_asset_id is not null as has_cover
      from calendar_reminders r
      join calendar_events e on e.id = r.event_id
      join calendar_labels l on l.id = e.label_id
      left join profiles p on p.user_id = r.user_id
      where r.user_id = ${g.user_id} and r.kind = ${g.kind} and r.occurrence_date = ${g.occurrence_date}::date
        and r.status = 'scheduled' and r.send_at <= ${nowIso}::timestamptz and e.deleted_at is null and p.deleted_at is null
      order by e.starts_at, r.id
      for update of r skip locked`);
    if (!rows.length) return 0; // another run holds or already sent them
    const tz = validTz(rows[0]!.tz);
    const name = rows[0]!.name?.trim().split(/\s+/)[0] || null;
    const { appUrl } = env();
    const calendarUrl = `${appUrl}/app/calendario`;
    // The first reminder id names the send: a retry after a crash reuses it, so notify() dedupes (D-780).
    const reference = [...rows.map((r) => r.id)].sort()[0]!;
    const item = (r: Due) => ({
      eventId: r.event_id, title: r.title, labelName: r.label_name, labelColor: r.label_color, startsAt: iso(r.starts_at),
      endsAt: r.ends_at ? iso(r.ends_at) : null, allDay: r.all_day, location: r.location,
    });
    const res =
      rows.length === 1
        ? await notify(g.user_id, g.kind === 'd1' ? 'calendar_d1' : 'calendar_d0', {
            reference,
            href: '/app/calendario',
            groupKey: `calendar:${g.kind}:${g.occurrence_date}`,
            data: { eventId: rows[0]!.event_id, title: rows[0]!.title, startsAt: iso(rows[0]!.starts_at), allDay: rows[0]!.all_day, location: rows[0]!.location },
            email: {
              ...item(rows[0]!), version: g.kind, timezone: tz, description: rows[0]!.description,
              coverUrl: rows[0]!.has_cover ? coverUrlFor(rows[0]!.event_id) : null, // P-322: stable token URL, redirects to a fresh signed one
              calendarUrl, icsUrl: icsUrlFor(rows[0]!.event_id), dueCards: await dueCards(g.user_id, now), reviewUrl: `${appUrl}/app/revisar`,
            },
          })
        : await notify(g.user_id, 'calendar_digest', {
            reference,
            href: '/app/calendario',
            groupKey: `calendar:${g.kind}:${g.occurrence_date}`,
            data: { window: g.kind, date: g.occurrence_date, count: rows.length, eventIds: rows.map((r) => r.event_id) },
            email: { version: 'varios', window: g.kind, name, date: g.occurrence_date, timezone: tz, events: rows.slice(0, DIGEST_MAX).map(item), calendarUrl },
          });
    await tx.execute(sql`
      update calendar_reminders set status = 'sent', notification_id = ${res.notificationId}, email_delivery_id = ${res.emailDeliveryId}
      where id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
    return rows.length;
  });
}

/** Returns how many reminder rows were sent, skipped (late) and canceled (event gone or reminder off). */
export async function dispatchDueReminders(now: Date, notify: Notify) {
  const { db } = await dbm();
  const nowIso = now.toISOString();
  // Safety net for writes that did not replan: deleted events and switched-off reminders never go out.
  const canceled = await db.execute<{ user_id: string }>(sql`
    update calendar_reminders r set status = 'canceled' from calendar_events e
    where e.id = r.event_id and r.status = 'scheduled' and r.send_at <= ${nowIso}::timestamptz
      and (e.deleted_at is not null or (r.kind = 'd1' and not e.remind_d1) or (r.kind = 'd0' and not e.remind_d0))
    returning r.user_id`);
  const skipped = await db.execute<{ user_id: string }>(sql`
    update calendar_reminders r set status = 'skipped' from calendar_events e
    where e.id = r.event_id and r.status = 'scheduled' and r.send_at <= ${nowIso}::timestamptz
      and (r.send_at < ${nowIso}::timestamptz - make_interval(hours => ${STALE_HOURS}) or (not e.all_day and e.starts_at <= ${nowIso}::timestamptz))
    returning r.user_id`);
  for (const userId of new Set([...canceled, ...skipped].map((r) => r.user_id))) await invalidate('calendar.changed', { userId }); // the clock changed their reminders (FR-45)
  const groups = await db.execute<Group>(sql`
    select distinct user_id, kind, occurrence_date::text as occurrence_date from calendar_reminders
    where status = 'scheduled' and send_at <= ${nowIso}::timestamptz limit 1000`);
  let sent = 0;
  for (const g of groups) {
    try {
      const n = await sendGroup(g, now, notify);
      sent += n;
      if (n) await invalidate('calendar.changed', { userId: g.user_id }); // after COMMIT: the reminders are now `sent`
    } catch (e) {
      log.error('calendar reminder failed', { userId: g.user_id, kind: g.kind, error: e instanceof Error ? e.message : String(e) }); // retried next run
    }
  }
  const out = { sent, skipped: skipped.count, canceled: canceled.count };
  if (sent || skipped.count || canceled.count) log.info('calendar reminders', out);
  return out;
}
