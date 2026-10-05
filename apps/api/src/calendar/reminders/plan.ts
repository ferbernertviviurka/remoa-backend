// F25 FR-13/FR-14 (Q-051): when the calendar reminders go out. Pure: no clock, no database.
// Wall-clock math goes through Intl (no Temporal in Node 24 yet, no new dependency, D-775).
import { CALENDAR_REMINDER_RULES as R, type CalendarReminderKind } from '@remoa/contracts';

const DAY = 86_400_000;
const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })));
  return f;
};
/** The local wall clock of instant `t` in `tz`, encoded as UTC ms (same y-m-d h:m:s). */
const wallOf = (tz: string, t: number) => {
  const p = Object.fromEntries(fmt(tz).formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
};
const offset = (tz: string, t: number) => wallOf(tz, t) - (t - (t % 1000));

/** Instant of local `date` + `minutes` in `tz`, like Temporal 'compatible': a time in a DST gap moves forward, an ambiguous one takes the earlier instant. */
export function zonedInstant(date: string, minutes: number, tz: string): Date {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const before = wall - offset(tz, wall - DAY);
  const after = wall - offset(tz, wall + DAY);
  const valid = [before, after].filter((t) => wallOf(tz, t) === wall);
  return new Date(valid.length ? Math.min(...valid) : before);
}

/** Local date (YYYY-MM-DD) and time (HH:MM) of an instant. */
export const localOf = (t: Date, tz: string) => {
  const w = new Date(wallOf(tz, t.getTime())).toISOString();
  return { date: w.slice(0, 10), time: w.slice(11, 16) };
};

/** A usable IANA name, else the product default (same fallback as review/queue dayWindow). */
export const validTz = (tz: string | null | undefined): string => {
  try {
    if (tz) new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
};

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The event as the plan sees it: local date and start in the profile timezone; `startTime` null = all day. */
export type PlanEvent = { date: string; startTime: string | null; remindD1: boolean; remindD0: boolean };
export type PlannedReminder = { kind: CalendarReminderKind; occurrenceDate: string; sendAt: Date; status: 'scheduled' | 'skipped' };

/**
 * D-776: a timed event is a fixed instant, re-read in the profile timezone (a new timezone can move its local date); an all-day event
 * keeps the date it was saved with (`starts_at` = local midnight in the event's own `timezone`) and takes the profile timezone's hours.
 */
export const eventForPlan = (
  e: { startsAt: Date; allDay: boolean; timezone: string; remindD1: boolean; remindD0: boolean },
  profileTz: string,
): PlanEvent => {
  const local = localOf(e.startsAt, e.allDay ? e.timezone : profileTz);
  return { date: local.date, startTime: e.allDay ? null : local.time, remindD1: e.remindD1, remindD0: e.remindD0 };
};

/**
 * d1 = 18:00 the day before; d0 = 07:00, or 1 h before a start earlier than 08:00, never before 05:00 (D-777: if that is not before
 * the start, d0 is skipped). A send time <= now is `skipped`. An event already started (all-day: its day over) gets nothing.
 */
export function planReminders(ev: PlanEvent, tz: string, now: Date): PlannedReminder[] {
  const start = ev.startTime === null ? null : minutesOf(ev.startTime);
  const startsAt = start === null ? null : zonedInstant(ev.date, start, tz);
  if (now >= (startsAt ?? zonedInstant(shiftDay(ev.date, 1), 0, tz))) return [];
  const out: PlannedReminder[] = [];
  const push = (kind: CalendarReminderKind, sendAt: Date, possible = true) =>
    out.push({ kind, occurrenceDate: ev.date, sendAt, status: possible && sendAt > now ? 'scheduled' : 'skipped' });
  if (ev.remindD1) push('d1', zonedInstant(shiftDay(ev.date, -1), R.d1Hour * 60, tz));
  if (ev.remindD0) {
    const m = start !== null && start < R.earlyStartBeforeHour * 60 ? Math.max(start - R.earlyLeadMinutes, R.notBeforeHour * 60) : R.d0Hour * 60;
    const sendAt = zonedInstant(ev.date, m, tz);
    push('d0', sendAt, !startsAt || sendAt < startsAt);
  }
  return out;
}
