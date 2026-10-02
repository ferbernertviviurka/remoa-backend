// F13 Minha conta. RLS and column GRANTs in migrations/0012_f13_account.sql (hand-appended).
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accountEventTypes } from '@remoa/contracts';
import { timestamps, userId } from './common';

/** One row per user, created on first PATCH /v1/account/preferences; absent = DEFAULT_PREFERENCES. */
export const userPreferences = pgTable('user_preferences', {
  userId: userId().primaryKey(),
  theme: text('theme').notNull().default('light'),
  /** null = follow the system's prefers-reduced-motion. */
  reduceMotion: boolean('reduce_motion'),
  reminderEnabled: boolean('reminder_enabled').notNull().default(false),
  reminderHour: smallint('reminder_hour').notNull().default(19),
  /** null = never chosen (= plan cap); effective value = effectiveNewCardsPerDay(). */
  newCardsPerDay: smallint('new_cards_per_day'),
  emailReviewReminders: boolean('email_review_reminders').notNull().default(true),
  emailProductNews: boolean('email_product_news').notNull().default(false),
  /** Server-owned: local date (profile timezone) of the last reminder e-mail. */
  reminderLastSentOn: date('reminder_last_sent_on', { mode: 'string' }),
  ...timestamps,
}, (t) => [
  check('user_preferences_theme', sql`${t.theme} in ('light', 'dark', 'system')`),
  check('user_preferences_reminder_hour', sql`${t.reminderHour} in (8, 12, 19, 21)`),
  check('user_preferences_new_cards', sql`${t.newCardsPerDay} between 5 and 20 and ${t.newCardsPerDay} % 5 = 0`),
]);

export const accountEventTypeEnum = pgEnum('account_event_type', accountEventTypes);

/** Audit log + rate-limit counter. Server-only writes; `meta` holds no personal data beyond IP/UA hashes. */
export const accountEvents = pgTable('account_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  type: accountEventTypeEnum('type').notNull(),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [index('account_events_user_type_idx').on(t.userId, t.type, t.createdAt)]);
