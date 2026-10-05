// G18 F25 Calendário (CCR-034, D-739–D-741). RLS (label and cover ownership in the write policies), grants and the reminder
// index are hand-appended in migrations/0026_g18_notifications_calendar.sql.
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { calendarColors, calendarReminderKinds, calendarReminderStatuses, calendarSystemLabels } from '@remoa/contracts';
import { timestamps, userId } from './common';
import { assets } from './content';
import { emailDeliveries, notifications } from './notifications';

export const calendarColorEnum = pgEnum('calendar_color', calendarColors);
export const calendarReminderKindEnum = pgEnum('calendar_reminder_kind', calendarReminderKinds);
export const calendarReminderStatusEnum = pgEnum('calendar_reminder_status', calendarReminderStatuses);

/** Per-user rows; the 5 defaults are seeded lazily with system_key (D-740). `personal` cannot be deleted (policy). */
export const calendarLabels = pgTable('calendar_labels', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  name: text('name').notNull(),
  color: calendarColorEnum('color').notNull(),
  systemKey: text('system_key'),
  position: smallint('position').notNull().default(0),
  ...timestamps,
}, (t) => [
  index('calendar_labels_user_idx').on(t.userId, t.position),
  uniqueIndex('calendar_labels_system_idx').on(t.userId, t.systemKey).where(sql`${t.systemKey} is not null`),
  check('calendar_labels_name', sql`char_length(${t.name}) between 2 and 40`),
  check('calendar_labels_system_key', sql.raw(`system_key in (${calendarSystemLabels.map((k) => `'${k}'`).join(', ')})`)),
]);

/** Instants in UTC; `timezone` = profile timezone at save (local date/time are derived from it). Soft delete for 30 days. */
export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  title: text('title').notNull(),
  labelId: uuid('label_id').notNull().references(() => calendarLabels.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  allDay: boolean('all_day').notNull().default(false),
  timezone: text('timezone').notNull(),
  location: text('location'),
  description: text('description'),
  coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
  remindD1: boolean('remind_d1').notNull().default(true),
  remindD0: boolean('remind_d0').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('calendar_events_user_starts_idx').on(t.userId, t.startsAt).where(sql`${t.deletedAt} is null`),
  index('calendar_events_label_idx').on(t.labelId),
  index('calendar_events_deleted_idx').on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  check('calendar_events_title', sql`char_length(${t.title}) between 2 and 120`),
  check('calendar_events_location', sql`char_length(${t.location}) <= 160`),
  check('calendar_events_description', sql`char_length(${t.description}) <= 2000`),
  check('calendar_events_ends', sql`${t.endsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
]);

/** Planned sends. Server-owned; owner reads (drawer shows the time). user_id denormalized for RLS and the dispatcher. */
export const calendarReminders = pgTable('calendar_reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  eventId: uuid('event_id').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
  kind: calendarReminderKindEnum('kind').notNull(),
  occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
  sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
  status: calendarReminderStatusEnum('status').notNull().default('scheduled'),
  notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
  emailDeliveryId: uuid('email_delivery_id').references(() => emailDeliveries.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  uniqueIndex('calendar_reminders_occurrence_idx').on(t.eventId, t.kind, t.occurrenceDate),
  index('calendar_reminders_due_idx').on(t.sendAt).where(sql`${t.status} = 'scheduled'`),
  index('calendar_reminders_user_idx').on(t.userId, t.sendAt),
]);
