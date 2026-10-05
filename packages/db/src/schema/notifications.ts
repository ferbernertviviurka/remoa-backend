// G18 F26 notifications + F24 e-mail log (CCR-034, D-736, D-742, D-743). RLS, grants, CHECKs on fixed channels, the
// user_preferences backfill and the Realtime publication are hand-appended in migrations/0026_g18_notifications_calendar.sql.
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { emailStatuses, emailTemplates, notificationCategories, notificationPrefKeys, notificationTypes } from '@remoa/contracts';
import { authUsers, timestamps, userId } from './common';

export const notificationTypeEnum = pgEnum('notification_type', notificationTypes);
export const notificationCategoryEnum = pgEnum('notification_category', notificationCategories);
export const notificationPrefKeyEnum = pgEnum('notification_pref_key', notificationPrefKeys);
export const emailTemplateEnum = pgEnum('email_template', emailTemplates);
export const emailStatusEnum = pgEnum('email_status', emailStatuses);

/**
 * In-app notices, written only by notify() (server connection). No title/body: the web renders them from type + data (D-742).
 * Owner reads (and gets Realtime); owner may set read_at / dismissed_at only.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  type: notificationTypeEnum('type').notNull(),
  category: notificationCategoryEnum('category').notNull(),
  /** App path ("/app/..."), never an absolute URL. */
  href: text('href'),
  data: jsonb('data').notNull().default({}),
  groupKey: text('group_key'),
  /** `${type}:${reference}` from notify(); unique per user. */
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  readAt: timestamp('read_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('notifications_idempotency_idx').on(t.userId, t.idempotencyKey),
  index('notifications_user_created_idx').on(t.userId, t.createdAt.desc()),
  index('notifications_unread_idx').on(t.userId).where(sql`${t.readAt} is null and ${t.dismissedAt} is null`),
  check('notifications_href', sql`${t.href} is null or ${t.href} like '/%'`),
]);

/** Matrix App × E-mail. A row only when the user changed a default (NOTIFICATION_PREFS in contracts). */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: userId(),
  key: notificationPrefKeyEnum('key').notNull(),
  inApp: boolean('in_app').notNull(),
  email: boolean('email').notNull(),
  ...timestamps,
}, (t) => [
  primaryKey({ columns: [t.userId, t.key] }),
  // Conta, cobrança e suporte nunca desligam o e-mail (F26 rules); mirrors NOTIFICATION_PREFS 'fixed'.
  check('notification_preferences_fixed_email', sql`${t.email} or ${t.key} not in ('support', 'account_billing')`),
]);

/** One row per send attempt group; (template, reference) is the idempotency key. Server only. Address kept only as a hash (FR-20). */
export const emailDeliveries = pgTable('email_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** null = address without an account. */
  userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
  template: emailTemplateEnum('template').notNull(),
  reference: text('reference').notNull(),
  /** Same D-386 hash as email_suppressions.email_hash. */
  toHash: text('to_hash').notNull(),
  providerId: text('provider_id'),
  status: emailStatusEnum('status').notNull().default('queued'),
  attempts: smallint('attempts').notNull().default(0),
  error: text('error'),
  /** EMAIL_TEST_REDIRECT was active: the real address never received it. */
  redirected: boolean('redirected').notNull().default(false),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  uniqueIndex('email_deliveries_idempotency_idx').on(t.template, t.reference),
  uniqueIndex('email_deliveries_provider_idx').on(t.providerId).where(sql`${t.providerId} is not null`),
  index('email_deliveries_user_idx').on(t.userId, t.createdAt.desc()),
  index('email_deliveries_template_idx').on(t.template, t.createdAt.desc()),
  check('email_deliveries_to_hash', sql`${t.toHash} ~ '^[0-9a-f]{64}$'`),
  check('email_deliveries_reference', sql`char_length(${t.reference}) between 1 and 200`),
]);
