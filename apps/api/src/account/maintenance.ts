// Maintenance jobs. Scheduled by Inngest crons (inngest/maintenance.ts); `pnpm job:maintenance` still runs both once by hand.
import { pathToFileURL } from 'node:url';
import { asJob } from '../db';
import { createLogger } from '@remoa/log';
import { env } from '@remoa/config';
import { createStripe, installStripe } from '../billing/stripe';
import { expireAnswerTexts, purgeDeletedAccounts } from './jobs';
import { sweepReferrals } from '../referral/sweep';
import { sweepSupport } from '../support/retention';
import { cleanOrphanAssets, purgeDeletedCards } from '../cleanup/assets';
import { sendOnboardingEmails } from '../onboarding/emails';
import { refreshRecentMetrics } from '../admin/overview/metrics';
import { failStaleJobs } from '../ai/service';
import { sweepTrialNotices } from '../billing/trial-notice';

const log = createLogger({ requestId: 'job-maintenance' });

/** Runs every step in order even when one throws (D-1570: one failing step used to skip the calendar reminders). */
export async function runSteps(steps: Record<string, () => Promise<unknown>>) {
  const out: Record<string, unknown> = {};
  const failed: string[] = [];
  for (const [step, run] of Object.entries(steps)) {
    try {
      out[step] = await run();
    } catch (e) {
      failed.push(step);
      log.error('maintenance step failed', { step, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { out, failed };
}

async function runAll(name: string, steps: Record<string, () => Promise<unknown>>) {
  const { out, failed } = await runSteps(steps);
  log.info(`maintenance ${name} done`, { ...out, failed });
  if (failed.length) throw new Error(`maintenance ${name} failed: ${failed.join(', ')}`);
  return out;
}

/** Hourly (cron `0 * * * *`), idempotent. The review reminder moved to the review.reminder job (G18, inngest/notices.ts). */
export function runHourly(now = new Date()) {
  return runAll('hourly', {
    referrals: () => sweepReferrals(now), // F18 (D-384)
    support: () => sweepSupport(now), // F19 FR-9 (Q-046)
    metrics: () => refreshRecentMetrics(now), // F19 FR-13 (D-458)
    onboarding: () => sendOnboardingEmails(now), // F12 FR-8 (D-525)
    staleJobs: () => failStaleJobs(), // G22 qa (P-617): AI jobs of a process that died give their unit back
    trial: () => sweepTrialNotices(now), // F30 (D-1213): "teste do Pro termina em 3 dias / hoje"
  });
}

/** Daily (cron `0 6 * * *` UTC): LGPD purge and answer-text retention (F08 FR-8). */
export function runDaily(now = new Date()) {
  return runAll('daily', {
    purged: async () => {
      const stripe = process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin: env().webOrigins[0]! }) : undefined;
      installStripe(stripe); // F18: the referral sweep re-applies pending credits
      return purgeDeletedAccounts(now, stripe);
    },
    expired: () => expireAnswerTexts(now),
    cards: () => purgeDeletedCards(now), // F01 P-009
    assets: () => cleanOrphanAssets(now), // F02 P-018 (also frees the assets of the cards just purged)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // FR-25 (D-993): job timeouts (30 s) for every run() of this process.
  const failed = await asJob(async () => {
    // G18: the Railway cron also runs the notice jobs (idempotent; Inngest runs them on their own schedule).
    // They go first so the calendar reminders never wait on (or die with) the maintenance sweeps (D-1570).
    const { noticeJobs } = await import('../inngest/notices');
    const notices = Object.fromEntries(Object.entries(noticeJobs).map(([job, j]) => [job, () => j.run(new Date())]));
    const { out, failed } = await runSteps({ ...notices, daily: () => runDaily(), hourly: () => runHourly() });
    log.info('maintenance cron done', { ...out, failed });
    return failed;
  });
  process.exit(failed.length ? 1 : 0);
}
