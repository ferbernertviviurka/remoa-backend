// F25 FR-14: keep calendar_reminders in step with the event. Called after every event write (create, edit, delete, duplicate,
// reminders on/off) and when the profile timezone changes. Idempotent: running it twice leaves the same rows.
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { eventForPlan, planReminders, validTz } from './plan';

/**
 * calendar_reminders is server-owned (authenticated only has SELECT). Callers usually hold a withUser() transaction, so the writes
 * step out of the `authenticated` role for their duration and step back (the connection is the superuser, D-021; D-778).
 */
async function asServer<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  const [r] = await tx.execute<{ role: string }>(sql`select current_user as role`);
  await tx.execute(sql`reset role`);
  const out = await fn();
  await tx.execute(sql`select set_config('role', ${r!.role}, true)`);
  return out;
}

type EventRow = { id: string; user_id: string; starts_at: Date | string; all_day: boolean; timezone: string; remind_d1: boolean; remind_d0: boolean; deleted_at: Date | string | null; tz: string | null };

async function replan(tx: Tx, e: EventRow, now: Date) {
  const tz = validTz(e.tz);
  const plan = e.deleted_at
    ? []
    : planReminders(eventForPlan({ startsAt: new Date(e.starts_at), allDay: e.all_day, timezone: validTz(e.timezone), remindD1: e.remind_d1, remindD0: e.remind_d0 }, tz), tz, now);
  for (const p of plan) {
    // A sent reminder never changes (and so never resends); anything else follows the plan.
    await tx.execute(sql`
      insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at, status)
      values (${e.user_id}, ${e.id}, ${p.kind}, ${p.occurrenceDate}::date, ${p.sendAt.toISOString()}::timestamptz, ${p.status})
      on conflict (event_id, kind, occurrence_date) do update set send_at = excluded.send_at, status = excluded.status
      where calendar_reminders.status <> 'sent' and (calendar_reminders.send_at, calendar_reminders.status) is distinct from (excluded.send_at, excluded.status)`);
  }
  const keep = plan.map((p) => sql`(${p.kind}, ${p.occurrenceDate}::date)`);
  await tx.execute(sql`
    update calendar_reminders set status = 'canceled'
    where event_id = ${e.id} and status = 'scheduled'
    ${keep.length ? sql`and (kind::text, occurrence_date) not in (${sql.join(keep, sql`, `)})` : sql``}`);
  return plan.length;
}

const eventsSql = (where: ReturnType<typeof sql>) => sql`
  select e.id, e.user_id, e.starts_at, e.all_day, e.timezone, e.remind_d1, e.remind_d0, e.deleted_at, p.timezone as tz
  from calendar_events e left join profiles p on p.user_id = e.user_id where ${where}`;

/** Upserts the event's d1/d0 rows: editing reschedules, deleting or switching off cancels, sent rows stay sent. Unknown id = no-op. */
export async function replanEventReminders(tx: Tx, eventId: string, now = new Date()): Promise<void> {
  const [e] = await tx.execute<EventRow>(eventsSql(sql`e.id = ${eventId}`));
  if (e) await asServer(tx, () => replan(tx, e, now));
}

/** Profile timezone changed: replan every future, live event of the user (past ones have nothing left to plan). */
export async function replanUserReminders(tx: Tx, userId: string, now = new Date()): Promise<number> {
  const rows = await tx.execute<EventRow>(eventsSql(sql`e.user_id = ${userId} and e.deleted_at is null and e.starts_at > ${now.toISOString()}::timestamptz - interval '2 days'`));
  return asServer(tx, async () => {
    let n = 0;
    for (const e of rows) n += await replan(tx, e, now);
    return n;
  });
}
