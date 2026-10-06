import { and, asc, eq, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import {
  CALENDAR_LIMITS, calendarErrors, calendarEventInputSchema, calendarEventPatchSchema, err, eventTimeIssues, idSchema, ok,
  type CalendarEvent, type CalendarEventList, type CalendarRangeQuery, type DuplicateEventInput, type EventRemindersInput, type Result, type UpcomingEvents,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { run, uuids } from '../db';
import { presignGet } from '../storage/storage';
import { DEFAULT_TZ, localCols, profileTz } from './common';
import { replanEventReminders } from './reminders/schedule';
import { invalidate } from '../cache';
import { pick } from '../pick';

type S = typeof import('@remoa/db');
export type EventInput = ReturnType<typeof calendarEventInputSchema.parse>;
export type EventPatch = ReturnType<typeof calendarEventPatchSchema.parse>;

/** `date time` in `tz` as an instant. No time = local midnight (all-day). */
const instant = (date: string, time: string | null, tz: string) => sql<Date>`(${date}::date + ${time ?? '00:00'}::time) at time zone ${tz}::text`;
const notFound = () => err<never>('not_found', 'event not found');

const select = (tx: Tx, s: S) =>
  tx.select({ e: s.calendarEvents, ...localCols(s) }).from(s.calendarEvents);

type Row = Awaited<ReturnType<ReturnType<typeof select>['where']>>[number];

/** Reminders and cover assets of the events `ids` selects (a list, or D-1094 the events' own query as a subquery: same flight). */
const list = (x: string[] | SQLWrapper) => (Array.isArray(x) ? uuids(x) : sql`array(${x})`);
const extras = (tx: Tx, s: S, ids: string[] | SQLWrapper, assetIds: string[] | SQLWrapper) => Promise.all([
  tx.select(pick(s.calendarReminders, 'eventId', 'kind', 'occurrenceDate', 'sendAt', 'status')).from(s.calendarReminders).where(sql`${s.calendarReminders.eventId} = any(${list(ids)})`).orderBy(asc(s.calendarReminders.sendAt)),
  Array.isArray(assetIds) && !assetIds.length ? [] : tx.select({ id: s.assets.id, key: s.assets.key }).from(s.assets).where(sql`${s.assets.id} = any(${list(assetIds)})`),
]);

async function present(tx: Tx, s: S, rows: Row[], pre?: Awaited<ReturnType<typeof extras>>): Promise<CalendarEvent[]> {
  if (!rows.length) return [];
  const [plans, assets] = pre ?? await extras(tx, s, rows.map((r) => r.e.id), rows.flatMap((r) => (r.e.coverAssetId ? [r.e.coverAssetId] : [])));
  const covers = new Map(await Promise.all(assets.map(async (a) => [a.id, { assetId: a.id, urls: { w800: await presignGet(`${a.key}/w800.webp`), w1600: await presignGet(`${a.key}/w1600.webp`) } }] as const)));
  return rows.map(({ e, date, st, et }) => ({
    id: e.id, title: e.title, labelId: e.labelId, date, allDay: e.allDay, startTime: st, endTime: et, startsAt: e.startsAt, endsAt: e.endsAt, timezone: e.timezone,
    location: e.location, description: e.description, cover: (e.coverAssetId && covers.get(e.coverAssetId)) || null, remindD1: e.remindD1, remindD0: e.remindD0,
    reminders: plans.filter((p) => p.eventId === e.id).map((p) => ({ kind: p.kind, occurrenceDate: p.occurrenceDate, sendAt: p.sendAt, status: p.status })),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }));
}

const loadOne = async (tx: Tx, s: S, userId: string, id: string) => {
  const rows = await select(tx, s).where(and(eq(s.calendarEvents.id, id), eq(s.calendarEvents.userId, userId), isNull(s.calendarEvents.deletedAt)));
  return rows;
};

export async function listEvents(userId: string, q: CalendarRangeQuery): Promise<Result<CalendarEventList>> {
  return ok({
    events: await run(userId, async (tx, s) => {
      const e = s.calendarEvents;
      // the starts_at bounds (±2 days) only exist to use the index; the exact filter is the local date
      const where = and(
        eq(e.userId, userId), isNull(e.deletedAt),
        sql`${e.startsAt} >= (${q.from}::date - 2)::timestamptz and ${e.startsAt} < (${q.to}::date + 3)::timestamptz`,
        sql`${localCols(s).date} between ${q.from} and ${q.to}`,
      );
      // G21 D-1094: one flight; reminders and covers select the same events in SQL
      const [rows, pre] = await Promise.all([
        select(tx, s).where(where).orderBy(asc(e.startsAt), asc(e.createdAt)),
        extras(tx, s, tx.select({ id: e.id }).from(e).where(where), tx.select({ id: e.coverAssetId }).from(e).where(where)),
      ]);
      return present(tx, s, rows, pre);
    }),
  });
}

/** Label and cover must be the caller's own; the RLS policy says the same, this gives the typed error. */
const checkRefs = async (tx: Tx, s: S, userId: string, labelId: string, coverAssetId: string | null) => {
  const [l] = await tx.select({ id: s.calendarLabels.id }).from(s.calendarLabels).where(and(eq(s.calendarLabels.id, labelId), eq(s.calendarLabels.userId, userId)));
  if (!l) return err<never>('validation', calendarErrors.badLabel);
  if (coverAssetId) {
    const [a] = await tx.select({ id: s.assets.id }).from(s.assets).where(and(eq(s.assets.id, coverAssetId), eq(s.assets.userId, userId)));
    if (!a) return err<never>('validation', calendarErrors.badCover);
  }
  return null;
};

type Fields = Pick<EventInput, 'title' | 'labelId' | 'date' | 'allDay' | 'startTime' | 'endTime' | 'location' | 'description' | 'coverAssetId' | 'remindD1' | 'remindD0'>;
const columns = (f: Fields, tz: string) => ({
  title: f.title, labelId: f.labelId, allDay: f.allDay, timezone: tz, location: f.location, description: f.description, coverAssetId: f.coverAssetId, remindD1: f.remindD1, remindD0: f.remindD0,
  startsAt: instant(f.date, f.allDay ? null : f.startTime, tz),
  endsAt: f.allDay || !f.endTime ? null : instant(f.date, f.endTime, tz),
});

export async function createEvent(userId: string, input: EventInput, now = new Date()): Promise<Result<CalendarEvent>> {
  const r = await run(userId, async (tx, s) => {
    const bad = await checkRefs(tx, s, userId, input.labelId, input.coverAssetId);
    if (bad) return bad;
    const tz = await profileTz(tx, userId);
    const [row] = await tx.insert(s.calendarEvents).values({ userId, ...columns(input, tz) }).returning({ id: s.calendarEvents.id });
    await replanEventReminders(tx, row!.id, now);
    return ok((await present(tx, s, await loadOne(tx, s, userId, row!.id)))[0]!);
  });
  if (r.ok) await invalidate('calendar.changed', { userId });
  return r;
}

export async function updateEvent(userId: string, id: string, patch: EventPatch, now = new Date()): Promise<Result<CalendarEvent>> {
  if (!idSchema.safeParse(id).success) return notFound();
  const r = await run(userId, async (tx, s) => {
    const [cur] = await loadOne(tx, s, userId, id);
    if (!cur) return notFound();
    const m: Fields = {
      title: cur.e.title, labelId: cur.e.labelId, date: cur.date, allDay: cur.e.allDay, startTime: cur.st, endTime: cur.et, location: cur.e.location, description: cur.e.description,
      coverAssetId: cur.e.coverAssetId, remindD1: cur.e.remindD1, remindD0: cur.e.remindD0, ...patch,
    };
    if (patch.allDay === true) {
      if (patch.startTime === undefined) m.startTime = null;
      if (patch.endTime === undefined) m.endTime = null;
    }
    const issues = eventTimeIssues(m);
    if (issues.length) return err<never>('validation', issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    if (patch.labelId !== undefined || (patch.coverAssetId && patch.coverAssetId !== cur.e.coverAssetId)) {
      const bad = await checkRefs(tx, s, userId, m.labelId, patch.coverAssetId !== undefined ? m.coverAssetId : null);
      if (bad) return bad;
    }
    await tx.update(s.calendarEvents).set(columns(m, await profileTz(tx, userId))).where(eq(s.calendarEvents.id, id));
    await replanEventReminders(tx, id, now);
    return ok((await present(tx, s, await loadOne(tx, s, userId, id)))[0]!);
  });
  if (r.ok) await invalidate('calendar.changed', { userId });
  return r;
}

export async function deleteEvent(userId: string, id: string, now = new Date()): Promise<Result<null>> {
  if (!idSchema.safeParse(id).success) return notFound();
  const r = await run(userId, async (tx, s) => {
    const e = s.calendarEvents;
    const done = await tx.update(e).set({ deletedAt: now }).where(and(eq(e.id, id), eq(e.userId, userId), isNull(e.deletedAt))).returning({ id: e.id });
    if (!done.length) return notFound();
    await replanEventReminders(tx, id, now); // cancels the scheduled sends of a deleted event
    return ok(null);
  });
  if (r.ok) await invalidate('calendar.changed', { userId });
  return r;
}

/** Same wall-clock time, `days` later (default +7), same label, cover and reminders. */
export async function duplicateEvent(userId: string, id: string, input: Required<DuplicateEventInput>, now = new Date()): Promise<Result<CalendarEvent>> {
  if (!idSchema.safeParse(id).success) return notFound();
  const r = await run(userId, async (tx, s) => {
    const shift = (col: string) => sql.raw(`((${col} at time zone timezone) + make_interval(days => ${Math.trunc(input.days)})) at time zone timezone`);
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into calendar_events (user_id, title, label_id, starts_at, ends_at, all_day, timezone, location, description, cover_asset_id, remind_d1, remind_d0)
      select user_id, title, label_id, ${shift('starts_at')}, case when ends_at is null then null else ${shift('ends_at')} end, all_day, timezone, location, description, cover_asset_id, remind_d1, remind_d0
      from calendar_events where id = ${id} and user_id = ${userId} and deleted_at is null returning id`);
    if (!row) return notFound();
    await replanEventReminders(tx, row.id, now);
    return ok((await present(tx, s, await loadOne(tx, s, userId, row.id)))[0]!);
  });
  if (r.ok) await invalidate('calendar.changed', { userId });
  return r;
}

export async function setEventReminders(userId: string, id: string, input: EventRemindersInput, now = new Date()): Promise<Result<CalendarEvent>> {
  if (!idSchema.safeParse(id).success) return notFound();
  const r = await run(userId, async (tx, s) => {
    const done = await tx.update(s.calendarEvents).set({ ...(input.remindD1 !== undefined && { remindD1: input.remindD1 }), ...(input.remindD0 !== undefined && { remindD0: input.remindD0 }) })
      .where(and(eq(s.calendarEvents.id, id), eq(s.calendarEvents.userId, userId), isNull(s.calendarEvents.deletedAt))).returning({ id: s.calendarEvents.id });
    if (!done.length) return notFound();
    await replanEventReminders(tx, id, now);
    return ok((await present(tx, s, await loadOne(tx, s, userId, id)))[0]!);
  });
  if (r.ok) await invalidate('calendar.changed', { userId });
  return r;
}

const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/** Hoje: from today (profile timezone) on; a timed event that already ended is gone, an all-day one stays all day. Hidden labels included. */
export async function upcoming(userId: string, limit: number, now: Date): Promise<Result<UpcomingEvents>> {
  return ok(await run(userId, async (tx, s) => {
    const e = s.calendarEvents;
    // G21 D-1094: one flight; the SQL reads the profile's day itself (tz validated on write, as windowSql)
    const [tz, rows] = await Promise.all([profileTz(tx, userId), tx
      .select({ e, ...localCols(s), labelName: s.calendarLabels.name, color: s.calendarLabels.color })
      .from(e).innerJoin(s.calendarLabels, eq(s.calendarLabels.id, e.labelId))
      .where(and(
        eq(e.userId, userId), isNull(e.deletedAt),
        sql`${localCols(s).date} >= to_char(${now.toISOString()}::timestamptz at time zone coalesce((select timezone from profiles where user_id = ${userId}), ${DEFAULT_TZ}::text), 'YYYY-MM-DD')`,
        sql`(${e.allDay} or coalesce(${e.endsAt}, ${e.startsAt}) >= ${now.toISOString()}::timestamptz)`,
      ))
      .orderBy(asc(e.startsAt), asc(e.createdAt))
      .limit(Math.min(limit, CALENDAR_LIMITS.upcomingMax))]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    return {
      events: rows.map((r) => ({
        id: r.e.id, title: r.e.title, labelId: r.e.labelId, labelName: r.labelName, color: r.color, date: r.date, allDay: r.e.allDay, startTime: r.st, endTime: r.et,
        startsAt: r.e.startsAt, location: r.e.location, daysUntil: Math.max(0, dayNumber(r.date) - dayNumber(today)),
      })),
      within24h: rows.some((r) => r.e.startsAt >= now && r.e.startsAt.getTime() - now.getTime() <= 86_400_000),
    };
  }));
}
