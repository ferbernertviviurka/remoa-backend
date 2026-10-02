// ponytail: cron entry until Inngest lands (F05 owns apps/api/src/inngest); then wrap these two functions in scheduled functions and delete this file.
import { createLogger } from '@remoa/log';
import { createStripe } from '../billing/stripe';
import { expireAnswerTexts, purgeDeletedAccounts } from './jobs';
import { sendDailyReminders } from './reminders';

const log = createLogger({ requestId: 'job-maintenance' });
const now = new Date();
const stripe = process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' }) : undefined;
const purged = await purgeDeletedAccounts(now, stripe);
const expired = await expireAnswerTexts(now);
// ponytail: F13 FR-15 daily reminder; this runner must run every hour (cron `0 * * * *`). Becomes an hourly Inngest cron when Inngest exists.
const reminded = await sendDailyReminders(now);
log.info('maintenance done', { purged, expired, reminded });
process.exit(0);
