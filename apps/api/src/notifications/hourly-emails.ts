// Notification e-mails (calendar, review, inactivity, onboarding, trial) are due on a clock.
// Inngest crons and railway.cron.json (`0 * * * *` → maintenance.ts) are the other schedules.
// Production runs neither (no Inngest signing key, API service is not a cron), so this process runs the sweep.
import { createLogger } from '@remoa/log';
import { runSteps } from '../account/maintenance';
import { sweepTrialNotices } from '../billing/trial-notice';
import { asJob, dbm } from '../db';
import { noticeJobs } from '../inngest/notices';
import { sendOnboardingEmails } from '../onboarding/emails';

const log = createLogger({ requestId: 'job-notification-emails' });
const LOCK_KEY = 'remoa:notification-emails';
export const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds until the next UTC hour boundary. Exactly on the hour waits a full hour. */
export function msUntilNextHour(now = Date.now()) {
  const rem = now % HOUR_MS;
  return rem === 0 ? HOUR_MS : HOUR_MS - rem;
}

/** `0 13 * * *` → 13. A stepped or wildcard hour is not a once-a-day gate. */
function dailyHour(cron: string): number | null {
  const [minute, hour] = cron.split(' ');
  if (minute !== '0' || !hour || !/^\d{1,2}$/.test(hour)) return null;
  const n = Number(hour);
  return n >= 0 && n <= 23 ? n : null;
}

type Step = () => Promise<unknown>;

/**
 * Jobs that look for notification e-mails that are due. Calendar and review are finer on Inngest
 * (5 and 15 min); once an hour still lands inside the calendar stale window (3 h) and inside each
 * user's reminder hour. Inactivity stays on its daily hour so a deploy does not mail everyone.
 */
export function dueNotificationEmailSteps(now: Date): Record<string, Step> {
  const steps: Record<string, Step> = {
    'calendar.dispatch-reminders': () => noticeJobs['calendar.dispatch-reminders'].run(now),
    'review.reminder': () => noticeJobs['review.reminder'].run(now),
    onboarding: () => sendOnboardingEmails(now),
    trial: () => sweepTrialNotices(now),
  };
  const inactivityHour = dailyHour(noticeJobs['inactivity.check'].cron);
  if (inactivityHour !== null && now.getUTCHours() === inactivityHour) {
    steps['inactivity.check'] = () => noticeJobs['inactivity.check'].run(now);
  }
  return steps;
}

type Held = {
  unsafe: (q: string, args?: unknown[]) => Promise<{ locked?: boolean }[]>;
  release: () => void;
};

/** One replica holds the session lock for the sweep. The others skip. */
async function withSweepLock<T>(fn: () => Promise<T>): Promise<T | { skipped: 'locked' }> {
  const { db } = await dbm();
  const held = await db.$client.reserve() as Held;
  const beat = setInterval(() => {
    void held.unsafe('select 1').catch(() => undefined);
  }, 30_000);
  beat.unref();
  try {
    const [row] = await held.unsafe('select pg_try_advisory_lock(hashtext($1)) as locked', [LOCK_KEY]);
    if (!row?.locked) return { skipped: 'locked' };
    try {
      return await fn();
    } finally {
      await held.unsafe('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    }
  } finally {
    clearInterval(beat);
    held.release();
  }
}

/** Looks up the notification e-mails that are due and sends them. One failure does not skip the rest. */
export async function runDueNotificationEmails(now = new Date()) {
  const result = await asJob(() => withSweepLock(async () => {
    const { out, failed } = await runSteps(dueNotificationEmailSteps(now));
    log.info('notification emails done', { ...out, failed });
    return { ...out, failed };
  }));
  if (result && typeof result === 'object' && 'skipped' in result) log.info('notification emails skipped', { reason: 'locked' });
  return result;
}

let started = false;
let inflight: Promise<unknown> = Promise.resolve();
/** The sweep still running, if any. SIGTERM waits on it (bounded by the caller). */
export const notificationEmailsInflight = () => inflight;

/** Runs once now, then on every UTC hour. A second call does nothing until `stop`. */
export function startHourlyNotificationEmails(run: (now: Date) => Promise<unknown> = runDueNotificationEmails) {
  if (started) return () => undefined;
  started = true;
  let running = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (running) return;
    running = true;
    inflight = Promise.resolve()
      .then(() => run(new Date()))
      .catch((e: unknown) => log.error('notification emails failed', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const arm = setTimeout(() => {
    tick();
    interval = setInterval(tick, HOUR_MS);
    interval.unref?.();
  }, msUntilNextHour());
  arm.unref?.();
  return () => {
    started = false;
    clearTimeout(arm);
    if (interval) clearInterval(interval);
  };
}
