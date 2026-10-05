// F13 Minha conta. RLS and column GRANTs in migrations/0012_f13_account.sql (hand-appended).
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accountEventTypes, calendarViews } from '@remoa/contracts';
import { timestamps, userId } from './common';

/** One row per user, created on first PATCH /v1/account/preferences; absent = DEFAULT_PREFERENCES. */
export const userPreferences = pgTable('user_preferences', {
  userId: userId().primaryKey(),
  theme: text('theme').notNull().default('light'),
  /** null = follow the system's prefers-reduced-motion. */
  reduceMotion: boolean('reduce_motion'),
  /** @deprecated G18 (D-743, P-301): notification_preferences 'review_reminder'.email is the source of truth (backfilled in 0026). */
  reminderEnabled: boolean('reminder_enabled').notNull().default(false),
  /** Local hour of the review reminder = NotificationPrefs.reviewReminderTime (D-744: 7, 8, 12, 20). */
  reminderHour: smallint('reminder_hour').notNull().default(20),
  /** null = never chosen (= plan cap); effective value = effectiveNewCardsPerDay(). */
  newCardsPerDay: smallint('new_cards_per_day'),
  /** @deprecated G18 (D-743, P-301): see reminderEnabled. */
  emailReviewReminders: boolean('email_review_reminders').notNull().default(true),
  emailProductNews: boolean('email_product_news').notNull().default(false),
  /** Server-owned: local date (profile timezone) of the last reminder e-mail. */
  reminderLastSentOn: date('reminder_last_sent_on', { mode: 'string' }),
  /** G18 F26: "Pausar e-mails de lembrete" (rows with NOTIFICATION_PREFS.pausable). */
  notifPauseReminders: boolean('notif_pause_reminders').notNull().default(false),
  /** G18 F25 (D-739): first tutorial close, any way; null = show the tour. */
  calendarTourSeenAt: timestamp('calendar_tour_seen_at', { withTimezone: true }),
  /** G18 F25: last view; null = client default (month on desktop, agenda on mobile). */
  calendarView: text('calendar_view'),
  /** G18 F25: calendar_labels ids switched off in the sidebar. */
  calendarHiddenLabels: uuid('calendar_hidden_labels').array().notNull().default(sql`'{}'::uuid[]`),
  ...timestamps,
}, (t) => [
  check('user_preferences_theme', sql`${t.theme} in ('light', 'dark', 'system')`),
  check('user_preferences_reminder_hour', sql`${t.reminderHour} in (7, 8, 12, 20)`),
  check('user_preferences_calendar_view', sql.raw(`calendar_view in (${calendarViews.map((v) => `'${v}'`).join(', ')})`)),
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
