// ponytail: cron entry until Inngest lands (F05 owns apps/api/src/inngest); then wrap these two functions in scheduled functions and delete this file.
import { createLogger } from '@remoa/log';
import { createStripe, installStripe } from '../billing/stripe';
import { expireAnswerTexts, purgeDeletedAccounts } from './jobs';
import { sendDailyReminders } from './reminders';
import { sweepReferrals } from '../referral/sweep';
import { sweepSupport } from '../support/retention';
import { refreshRecentMetrics } from '../admin/overview/metrics';

const log = createLogger({ requestId: 'job-maintenance' });
const now = new Date();
const stripe = process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }) : undefined;
installStripe(stripe); // F18: the referral sweep re-applies pending credits
const purged = await purgeDeletedAccounts(now, stripe);
const expired = await expireAnswerTexts(now);
// ponytail: F13 FR-15 daily reminder; this runner must run every hour (cron `0 * * * *`). Becomes an hourly Inngest cron when Inngest exists.
const reminded = await sendDailyReminders(now);
const referrals = await sweepReferrals(now); // F18 (D-384): expire invites, qualify what the hooks missed
const support = await sweepSupport(now); // F19 FR-9 (Q-046)
const metrics = await refreshRecentMetrics(now); // F19 FR-13 (D-458): admin_metrics_daily, yesterday + today
log.info('maintenance done', { purged, expired, reminded, referrals, support, metrics });
process.exit(0);
