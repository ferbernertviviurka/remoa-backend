import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  CALENDAR_LIMITS, DEFAULT_CALENDAR_LABELS, calendarErrors, err, idSchema, ok,
  type CalendarLabel, type CalendarLabelDeleted, type CalendarLabelInput, type CalendarLabelList, type CalendarLabelPatch, type Result,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm, run } from '../db';
import { invalidate } from '../cache';

/** D-740: seeded on the first read, only when the user has no label at all (a deleted default must not come back). */
const seed = async (tx: Tx, s: typeof import('@remoa/db'), userId: string) => {
  const [{ n = 0 } = {}] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.calendarLabels).where(eq(s.calendarLabels.userId, userId));
  if (n > 0) return;
  await tx.insert(s.calendarLabels).values(DEFAULT_CALENDAR_LABELS.map((l, position) => ({ userId, name: l.name, color: l.color, systemKey: l.systemKey, position }))).onConflictDoNothing();
};

const hiddenOf = async (userId: string) => {
  const { db, userPreferences: up } = await dbm();
  const [p] = await db.select({ h: up.calendarHiddenLabels }).from(up).where(eq(up.userId, userId));
  return p?.h ?? [];
};

const list = async (tx: Tx, s: typeof import('@remoa/db'), userId: string, hidden: string[]): Promise<CalendarLabel[]> => {
  const l = s.calendarLabels;
  const e = s.calendarEvents;
  const read = () => tx
    .select({ l, n: sql<number>`count(${e.id})::int` })
    .from(l)
    .leftJoin(e, and(eq(e.labelId, l.id), isNull(e.deletedAt)))
    .where(eq(l.userId, userId))
    .groupBy(l.id)
    .orderBy(asc(l.position), asc(l.createdAt));
  // G21 D-1094: the list is the seed check (no label at all → seed, read again; first visit only); one flight otherwise
  let rows = await read();
  if (!rows.length) {
    await seed(tx, s, userId);
    rows = await read();
  }
  return rows.map(({ l: r, n }) => ({
    id: r.id, name: r.name, color: r.color, systemKey: r.systemKey as CalendarLabel['systemKey'], position: r.position, hidden: hidden.includes(r.id), eventCount: n,
  }));
};

export async function listLabels(userId: string): Promise<Result<CalendarLabelList>> {
  // the preference (server connection) and the list, in parallel
  const hiddenP = hiddenOf(userId);
  hiddenP.catch(() => undefined); // awaited below; not unhandled if the list throws first
  const rows = await run(userId, (tx, s) => list(tx, s, userId, []));
  const hidden = await hiddenP;
  return ok({ labels: rows.map((l) => ({ ...l, hidden: hidden.includes(l.id) })) });
}

const one = async (userId: string, id: string) => {
  const r = await listLabels(userId);
  return r.ok ? r.data.labels.find((l) => l.id === id) : undefined;
};

export async function createLabel(userId: string, input: CalendarLabelInput): Promise<Result<CalendarLabel>> {
  const id = await run(userId, async (tx, s) => {
    await seed(tx, s, userId);
    const rows = await tx.select({ position: s.calendarLabels.position }).from(s.calendarLabels).where(eq(s.calendarLabels.userId, userId));
    if (rows.length >= CALENDAR_LIMITS.labels) return null;
    const [r] = await tx.insert(s.calendarLabels).values({ userId, name: input.name.trim(), color: input.color, position: Math.max(-1, ...rows.map((x) => x.position)) + 1 }).returning({ id: s.calendarLabels.id });
    return r!.id;
  });
  if (!id) return err('conflict', calendarErrors.labelLimit);
  await invalidate('calendar.changed', { userId });
  return ok((await one(userId, id))!);
}

export async function updateLabel(userId: string, id: string, patch: CalendarLabelPatch): Promise<Result<CalendarLabel>> {
  if (!idSchema.safeParse(id).success) return err('not_found', 'label not found');
  const { hidden, ...fields } = patch;
  const found = await run(userId, async (tx, s) => {
    if (Object.keys(fields).length === 0) return !!(await tx.select({ id: s.calendarLabels.id }).from(s.calendarLabels).where(eq(s.calendarLabels.id, id)))[0];
    const set = { ...(fields.name !== undefined && { name: fields.name.trim() }), ...(fields.color && { color: fields.color }), ...(fields.position !== undefined && { position: fields.position }) };
    return (await tx.update(s.calendarLabels).set(set).where(eq(s.calendarLabels.id, id)).returning({ id: s.calendarLabels.id })).length > 0;
  });
  if (!found) return err('not_found', 'label not found');
  if (hidden !== undefined) {
    const { db, userPreferences: up } = await dbm();
    const cur = await hiddenOf(userId);
    const next = hidden ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    await db.insert(up).values({ userId, calendarHiddenLabels: next }).onConflictDoUpdate({ target: up.userId, set: { calendarHiddenLabels: next, updatedAt: new Date() } });
  }
  await invalidate('calendar.changed', { userId });
  return ok((await one(userId, id))!);
}

/** The label's events (deleted ones too) move to `personal`, which itself cannot be deleted. */
export async function deleteLabel(userId: string, id: string): Promise<Result<CalendarLabelDeleted>> {
  if (!idSchema.safeParse(id).success) return err('not_found', 'label not found');
  const r = await run(userId, async (tx, s) => {
    const [label] = await tx.select({ systemKey: s.calendarLabels.systemKey }).from(s.calendarLabels).where(eq(s.calendarLabels.id, id));
    if (!label) return err<CalendarLabelDeleted>('not_found', 'label not found');
    if (label.systemKey === 'personal') return err<CalendarLabelDeleted>('conflict', calendarErrors.labelPersonal);
    const [personal] = await tx.select({ id: s.calendarLabels.id }).from(s.calendarLabels).where(and(eq(s.calendarLabels.userId, userId), eq(s.calendarLabels.systemKey, 'personal')));
    if (!personal) return err<CalendarLabelDeleted>('conflict', calendarErrors.labelPersonal);
    const moved = await tx.update(s.calendarEvents).set({ labelId: personal.id }).where(eq(s.calendarEvents.labelId, id)).returning({ deletedAt: s.calendarEvents.deletedAt });
    await tx.delete(s.calendarLabels).where(eq(s.calendarLabels.id, id));
    return ok({ movedTo: personal.id, moved: moved.filter((m) => !m.deletedAt).length });
  });
  if (r.ok) {
    await invalidate('calendar.changed', { userId });
    const cur = await hiddenOf(userId);
    if (cur.includes(id)) {
      const { db, userPreferences: up } = await dbm();
      await db.update(up).set({ calendarHiddenLabels: cur.filter((x) => x !== id), updatedAt: new Date() }).where(eq(up.userId, userId));
    }
  }
  return r;
}
