import { eq, sql } from 'drizzle-orm';
import { calendarViewSchema, ok, type CalendarSettings, type CalendarTourSeen, type CalendarView, type Result } from '@remoa/contracts';
import { dbm, run } from '../db';
import { profileTz } from './common';

export async function getSettings(userId: string): Promise<Result<CalendarSettings>> {
  const { db, userPreferences: up } = await dbm();
  const [p] = await db.select({ view: up.calendarView, tour: up.calendarTourSeenAt, hidden: up.calendarHiddenLabels }).from(up).where(eq(up.userId, userId));
  const timezone = await run(userId, (tx) => profileTz(tx, userId));
  return ok({ view: calendarViewSchema.safeParse(p?.view).data ?? null, tourSeenAt: p?.tour ?? null, timezone, hiddenLabelIds: p?.hidden ?? [] });
}

/** Idempotent: the first timestamp stays. */
export async function markTourSeen(userId: string, now = new Date()): Promise<Result<CalendarTourSeen>> {
  const { db, userPreferences: up } = await dbm();
  const [r] = await db.insert(up).values({ userId, calendarTourSeenAt: now })
    .onConflictDoUpdate({ target: up.userId, set: { calendarTourSeenAt: sql`coalesce(${up.calendarTourSeenAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now } })
    .returning({ at: up.calendarTourSeenAt });
  return ok({ tourSeenAt: r!.at! });
}

export async function setView(userId: string, view: CalendarView): Promise<Result<{ view: CalendarView }>> {
  const { db, userPreferences: up } = await dbm();
  await db.insert(up).values({ userId, calendarView: view }).onConflictDoUpdate({ target: up.userId, set: { calendarView: view, updatedAt: new Date() } });
  return ok({ view });
}
