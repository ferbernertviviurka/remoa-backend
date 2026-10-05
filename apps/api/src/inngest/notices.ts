// G18 notice jobs: Inngest crons, and the same bodies behind POST /v1/cron/:job (Railway cron / fallback). All idempotent.
import { sql } from 'drizzle-orm';
import { CALENDAR_LIMITS, NOTIFICATION_RETENTION_DAYS, type Notify } from '@remoa/contracts';
import { dbm } from '../db';
import { dispatchDueReminders } from '../calendar/reminders/dispatch';
import { sendDailyReminders } from '../account/reminders';
import { sendInactivityNotices } from '../account/inactivity';
import { inngest } from './client';

// Loaded when a job runs: the app (and its tests) boot without pulling the e-mail stack.
const notify: Notify = async (userId, type, payload, opts) => (await import('../notifications/notify')).notify(userId, type, payload, opts);

/** FR-10 / Q-058: read notices go after 90 days, unread after 180. */
export async function purgeOldNotifications(now: Date) {
  const { db } = await dbm();
  const at = now.toISOString();
  const r = await db.execute(sql`
    delete from notifications
    where created_at < ${at}::timestamptz - make_interval(days => case when read_at is null then ${NOTIFICATION_RETENTION_DAYS.unread}::int else ${NOTIFICATION_RETENTION_DAYS.read}::int end)`);
  return r.count;
}

/** Soft-deleted events are purged after 30 days (reminders cascade); the cover becomes an orphan asset and leaves with cleanOrphanAssets. */
export async function purgeDeletedEvents(now: Date) {
  const { db } = await dbm();
  const r = await db.execute(sql`delete from calendar_events where deleted_at < ${now.toISOString()}::timestamptz - make_interval(days => ${CALENDAR_LIMITS.deletedRetentionDays})`);
  return r.count;
}

export const noticeJobs = {
  'calendar.dispatch-reminders': { cron: '*/5 * * * *', run: (now: Date) => dispatchDueReminders(now, notify) },
  'review.reminder': { cron: '*/15 * * * *', run: (now: Date) => sendDailyReminders(now, notify) },
  'inactivity.check': { cron: '0 13 * * *', run: (now: Date) => sendInactivityNotices(now, notify) }, // 10:00 in São Paulo
  'notifications.retention': { cron: '30 6 * * *', run: purgeOldNotifications },
  'calendar.cleanup': { cron: '45 6 * * *', run: purgeDeletedEvents },
} as const;
export type NoticeJob = keyof typeof noticeJobs;
export const isNoticeJob = (s: string): s is NoticeJob => Object.hasOwn(noticeJobs, s);

export const noticeFunctions = Object.entries(noticeJobs).map(([id, j]) =>
  inngest.createFunction({ id: id.replace('.', '-'), retries: 1, concurrency: 1, triggers: [{ cron: j.cron }] }, async ({ step }) =>
    step.run(id, () => j.run(new Date())),
  ),
);
