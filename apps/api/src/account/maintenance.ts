// Maintenance jobs. Scheduled by Inngest crons (inngest/maintenance.ts); `pnpm job:maintenance` still runs both once by hand.
import { pathToFileURL } from 'node:url';
import { asJob } from '../db';
import { createLogger } from '@remoa/log';
import { createStripe, installStripe } from '../billing/stripe';
import { expireAnswerTexts, purgeDeletedAccounts } from './jobs';
import { sweepReferrals } from '../referral/sweep';
import { sweepSupport } from '../support/retention';
import { cleanOrphanAssets, purgeDeletedCards } from '../cleanup/assets';
import { sendOnboardingEmails } from '../onboarding/emails';
import { refreshRecentMetrics } from '../admin/overview/metrics';
import { failStaleJobs } from '../ai/service';

const log = createLogger({ requestId: 'job-maintenance' });

/** Hourly (cron `0 * * * *`), idempotent. The review reminder moved to the review.reminder job (G18, inngest/notices.ts). */
export async function runHourly(now = new Date()) {
  const referrals = await sweepReferrals(now); // F18 (D-384)
  const support = await sweepSupport(now); // F19 FR-9 (Q-046)
  const metrics = await refreshRecentMetrics(now); // F19 FR-13 (D-458)
  const onboarding = await sendOnboardingEmails(now); // F12 FR-8 (D-525)
  const staleJobs = await failStaleJobs(); // G22 qa (P-617): AI jobs of a process that died give their unit back
  const out = { referrals, support, metrics, onboarding, staleJobs };
  log.info('maintenance hourly done', out);
  return out;
}

/** Daily (cron `0 6 * * *` UTC): LGPD purge and answer-text retention (F08 FR-8). */
export async function runDaily(now = new Date()) {
  const stripe = process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }) : undefined;
  installStripe(stripe); // F18: the referral sweep re-applies pending credits
  const purged = await purgeDeletedAccounts(now, stripe);
  const expired = await expireAnswerTexts(now);
  const cards = await purgeDeletedCards(now); // F01 P-009
  const assets = await cleanOrphanAssets(now); // F02 P-018 (also frees the assets of the cards just purged)
  const out = { purged, expired, cards, assets };
  log.info('maintenance daily done', out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // FR-25 (D-993): job timeouts (30 s) for every run() of this process.
  await asJob(async () => {
    await runDaily();
    await runHourly();
    // G18: the Railway cron also runs the notice jobs once (idempotent; Inngest runs them on their own schedule).
    const { noticeJobs } = await import('../inngest/notices');
    for (const [job, j] of Object.entries(noticeJobs)) log.info('notice job done', { job, result: await j.run(new Date()) });
  });
  process.exit(0);
}
