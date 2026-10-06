import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { pick } from '../pick';
import {
  NOTIFICATION_PREFS, NOTIFICATIONS_PAGE_SIZE, effectivePref, err, idSchema, notificationCategories, notificationPrefKeys, ok, reviewReminderHour, reviewReminderTimeOf,
  type MarkReadInput, type Notification, type NotificationCategory, type NotificationPrefs, type NotificationPrefsPatch, type Result,
  type NotificationPage, type UnreadCount, type NotificationListQuery,
} from '@remoa/contracts';
import { dbm, run } from '../db';
import { invalidate } from '../cache';

// G18 F26. Rows are written only by notify(); here the owner reads them, marks them read and dismisses (RLS: select + update(read_at, dismissed_at)).

const CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?)\|([0-9a-f-]{36})$/;
const enc = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url');

export async function listNotifications(userId: string, q: NotificationListQuery): Promise<Result<NotificationPage>> {
  const limit = q.limit ?? NOTIFICATIONS_PAGE_SIZE;
  let cur: RegExpMatchArray | null = null;
  if (q.cursor) {
    cur = Buffer.from(q.cursor, 'base64url').toString().match(CURSOR);
    if (!cur) return err('validation', 'invalid cursor');
  }
  return ok(await run(userId, async (tx, s) => {
    const t = s.notifications;
    const rows = await tx
      .select({ row: t, ts: sql<string>`${t.createdAt}::text` })
      .from(t)
      .where(and(
        eq(t.userId, userId),
        isNull(t.dismissedAt),
        or(isNull(t.expiresAt), sql`${t.expiresAt} > now()`),
        q.filter === 'unread' ? isNull(t.readAt) : undefined,
        q.category ? eq(t.category, q.category) : undefined,
        cur ? sql`(${t.createdAt}, ${t.id}) < (${cur[1]}::timestamptz, ${cur[2]}::uuid)` : undefined,
      ))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ row: r }) => ({ id: r.id, type: r.type, category: r.category, href: r.href, groupKey: r.groupKey, createdAt: r.createdAt, readAt: r.readAt, data: r.data }) as Notification),
      nextCursor: rows.length > limit && last ? enc(last.ts, last.row.id) : null,
    };
  }));
}

const unreadWhere = (t: typeof import('@remoa/db').notifications, userId: string) =>
  and(eq(t.userId, userId), isNull(t.readAt), isNull(t.dismissedAt), or(isNull(t.expiresAt), sql`${t.expiresAt} > now()`));

export async function unreadCount(userId: string): Promise<Result<UnreadCount>> {
  return ok(await run(userId, async (tx, s) => {
    const rows = await tx.select({ category: s.notifications.category, n: sql<number>`count(*)::int` }).from(s.notifications).where(unreadWhere(s.notifications, userId)).groupBy(s.notifications.category);
    const byCategory = Object.fromEntries(notificationCategories.map((c) => [c, 0])) as Record<NotificationCategory, number>;
    for (const r of rows) byCategory[r.category] = r.n;
    return { total: rows.reduce((a, r) => a + r.n, 0), byCategory };
  }));
}

export async function markRead(userId: string, input: MarkReadInput): Promise<Result<{ updated: number; unread: number }>> {
  const out = await run(userId, async (tx, s) => {
    const t = s.notifications;
    const done = await tx.update(t).set({ readAt: new Date() }).where(and(unreadWhere(t, userId), 'ids' in input ? inArray(t.id, input.ids) : undefined)).returning({ id: t.id });
    const [{ n = 0 } = {}] = await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(unreadWhere(t, userId));
    return { updated: done.length, unread: n };
  });
  if (out.updated) await invalidate('notification.changed', { userId });
  return ok(out);
}

/** Soft: sets dismissed_at. Another user's id (invisible under RLS) = not_found; dismissing twice is fine. */
export async function dismiss(userId: string, id: string): Promise<Result<null>> {
  if (!idSchema.safeParse(id).success) return err('not_found', 'notification not found');
  const r = await run(userId, async (tx, s) => {
    const t = s.notifications;
    const done = await tx.update(t).set({ dismissedAt: new Date() }).where(and(eq(t.id, id), isNull(t.dismissedAt))).returning({ id: t.id });
    if (done.length) return ok(null);
    const [seen] = await tx.select({ id: t.id }).from(t).where(eq(t.id, id));
    return seen ? ok(null) : err('not_found', 'notification not found');
  });
  if (r.ok) await invalidate('notification.changed', { userId });
  return r;
}

export async function getPrefs(userId: string): Promise<Result<NotificationPrefs>> {
  const { db, userPreferences: up } = await dbm();
  const [rows, [pref]] = await Promise.all([
    run(userId, (tx, s) => tx.select(pick(s.notificationPreferences, 'key', 'inApp', 'email')).from(s.notificationPreferences).where(eq(s.notificationPreferences.userId, userId))),
    db.select({ pause: up.notifPauseReminders, hour: up.reminderHour }).from(up).where(eq(up.userId, userId)),
  ]);
  const matrix = Object.fromEntries(notificationPrefKeys.map((k) => [k, effectivePref(k, rows.find((r) => r.key === k) ?? null)])) as NotificationPrefs['matrix'];
  return ok({ matrix, pauseReminders: pref?.pause ?? false, reviewReminderTime: reviewReminderTimeOf(pref?.hour ?? 20) });
}

/** One review-reminder e-mail value, shared with the old F13 preferences (P-301). Returns nothing; callers re-read. */
export async function setPref(userId: string, key: (typeof notificationPrefKeys)[number], channel: 'inApp' | 'email', value: boolean) {
  await run(userId, async (tx, s) => {
    const t = s.notificationPreferences;
    const [row] = await tx.select(pick(t, 'inApp', 'email')).from(t).where(and(eq(t.userId, userId), eq(t.key, key)));
    const cur = effectivePref(key, row ?? null);
    const next = { ...cur, [channel]: value };
    await tx.insert(t).values({ userId, key, inApp: next.inApp, email: next.email }).onConflictDoUpdate({ target: [t.userId, t.key], set: { inApp: next.inApp, email: next.email } });
  });
  await invalidate('prefs.changed', { userId });
}

export async function patchPrefs(userId: string, patch: NotificationPrefsPatch): Promise<Result<NotificationPrefs>> {
  const { pref, pauseReminders, reviewReminderTime } = patch;
  // contract refine already refuses these; defense in depth for callers that skip it
  if (pref && ['fixed', 'none'].includes(NOTIFICATION_PREFS[pref.key][pref.channel])) return err('validation', 'channel is fixed or not offered');
  if (pref) await setPref(userId, pref.key, pref.channel, pref.value);
  if (pauseReminders !== undefined || reviewReminderTime) {
    const { db, userPreferences: up } = await dbm();
    const set = { ...(pauseReminders !== undefined && { notifPauseReminders: pauseReminders }), ...(reviewReminderTime && { reminderHour: reviewReminderHour(reviewReminderTime) }) };
    await db.insert(up).values({ userId, ...set }).onConflictDoUpdate({ target: up.userId, set: { ...set, updatedAt: new Date() } });
    await invalidate('prefs.changed', { userId });
  }
  return getPrefs(userId);
}
