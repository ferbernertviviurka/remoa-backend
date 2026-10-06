// G18 / F26 Central de notificações (feature file docs/features/F23-central-de-notificacoes.md). CCR-034, D-742–D-744.
// notify() is the only door for user notices (CLAUDE.md rule 10). Text is never stored: the web renders title/body from
// `type` + `data` with @remoa/strings (Torph rule 1), and e-mail text comes from @remoa/emails (D-742).
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { localDateSchema } from './calendar';
import type { EmailData, EmailTemplate } from './emails';
import { storeInterests } from './store';
import { notificationCategories, notificationTypes } from './constants';

export { notificationCategories, notificationTypes } from './constants'; // CCR-058: zod-free in ./constants
export const notificationTypeSchema = z.enum(notificationTypes);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Chips on /notificacoes: `notificationCategories` order (Todas is "no category"). */
export const notificationCategorySchema = z.enum(notificationCategories);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/** Rows of "Como avisar você" (FR-6), in display order. One notification_preferences row per (user, key) only when it differs from the default. */
export const notificationPrefKeys = ['calendar_d1', 'calendar_d0', 'review_reminder', 'map_ready', 'inactivity', 'referral', 'support', 'account_billing', 'store'] as const;
export const notificationPrefKeySchema = z.enum(notificationPrefKeys);
export type NotificationPrefKey = z.infer<typeof notificationPrefKeySchema>;

/**
 * Channel state per row: 'on'/'off' = offered, default on/off; 'fixed' = always on, locked (cadeado); 'none' = channel not offered.
 * `pausable`: "Pausar e-mails de lembrete" stops this row's e-mail. The DB refuses email=false on fixed rows (CHECK).
 * D-743: review_reminder e-mail defaults off (keeps F13's opt-in daily reminder); existing opt-ins were backfilled.
 */
export type ChannelState = 'on' | 'off' | 'fixed' | 'none';
export const NOTIFICATION_PREFS: Record<NotificationPrefKey, { category: NotificationCategory; inApp: ChannelState; email: ChannelState; pausable: boolean }> = {
  calendar_d1: { category: 'calendar', inApp: 'on', email: 'on', pausable: true },
  calendar_d0: { category: 'calendar', inApp: 'on', email: 'on', pausable: true },
  review_reminder: { category: 'review', inApp: 'on', email: 'off', pausable: true },
  map_ready: { category: 'maps', inApp: 'on', email: 'on', pausable: false },
  inactivity: { category: 'review', inApp: 'none', email: 'on', pausable: true },
  referral: { category: 'referrals', inApp: 'on', email: 'on', pausable: false },
  support: { category: 'support', inApp: 'on', email: 'fixed', pausable: false },
  account_billing: { category: 'account_billing', inApp: 'on', email: 'fixed', pausable: false },
  store: { category: 'store', inApp: 'on', email: 'on', pausable: false },
};

/**
 * Per type: category, preference row (calendar_digest: by `data.window`, see notificationPrefKey), whether an in-app row is created,
 * the e-mail template (D-760: every type has one; null kept for future in-app-only types) and the rank under the reminder e-mail cap (1 wins; null = not capped).
 */
export const NOTIFICATION_TYPES = {
  calendar_d1: { category: 'calendar', prefKey: 'calendar_d1', inApp: true, email: 'calendar-reminder', capRank: 1 },
  calendar_d0: { category: 'calendar', prefKey: 'calendar_d0', inApp: true, email: 'calendar-reminder', capRank: 1 },
  calendar_digest: { category: 'calendar', prefKey: null, inApp: true, email: 'calendar-reminder', capRank: 1 },
  review_reminder: { category: 'review', prefKey: 'review_reminder', inApp: true, email: 'review-reminder', capRank: 2 },
  map_ready: { category: 'maps', prefKey: 'map_ready', inApp: true, email: 'map-ready', capRank: null },
  referral_reward: { category: 'referrals', prefKey: 'referral', inApp: true, email: 'referral-reward', capRank: null },
  support_reply: { category: 'support', prefKey: 'support', inApp: true, email: 'support-reply', capRank: null },
  purchase: { category: 'account_billing', prefKey: 'account_billing', inApp: true, email: 'purchase-success', capRank: null },
  waitlist_joined: { category: 'store', prefKey: 'store', inApp: true, email: 'waitlist-confirm', capRank: null },
  inactivity: { category: 'review', prefKey: 'inactivity', inApp: false, email: 'inactivity', capRank: 3 },
  account: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'account-confirm', capRank: null },
  password_reset: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'password-reset', capRank: null },
  support_received: { category: 'support', prefKey: 'support', inApp: false, email: 'support-reply', capRank: null },
  password_changed: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'password-changed', capRank: null },
  welcome: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'welcome', capRank: null },
  onboarding_nudge: { category: 'review', prefKey: 'inactivity', inApp: false, email: 'onboarding-nudge', capRank: 3 },
  payment_receipt: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'payment-receipt', capRank: null },
  admin_alert: { category: 'account_billing', prefKey: 'account_billing', inApp: false, email: 'admin-alert', capRank: null },
  dispute_resolved: { category: 'support', prefKey: 'support', inApp: false, email: 'dispute-resolved', capRank: null },
  trial_ending: { category: 'account_billing', prefKey: 'account_billing', inApp: true, email: 'trial-ending', capRank: null },
} as const satisfies Record<
  NotificationType,
  { category: NotificationCategory; prefKey: NotificationPrefKey | null; inApp: boolean; email: EmailTemplate | null; capRank: 1 | 2 | 3 | null }
>;

/** FR-12 / Q-056: at most 2 reminder-class e-mails per user per rolling 24 h; the rest become in-app only. */
export const REMINDER_EMAIL_CAP = { max: 2, windowHours: 24 } as const;
/** FR-10 / Q-058. */
export const NOTIFICATION_RETENTION_DAYS = { read: 90, unread: 180 } as const;
export const NOTIFICATIONS_PAGE_SIZE = 20;

export type InAppNotificationType = { [T in NotificationType]: (typeof NOTIFICATION_TYPES)[T]['inApp'] extends true ? T : never }[NotificationType];
export type EmailNotificationType = { [T in NotificationType]: (typeof NOTIFICATION_TYPES)[T]['email'] extends EmailTemplate ? T : never }[NotificationType];
export type EmailTemplateOf<T extends EmailNotificationType> = Extract<(typeof NOTIFICATION_TYPES)[T]['email'], EmailTemplate>;

// --- in-app data, per type (what the web needs to render and link) -----------
const iso = z.string().datetime({ offset: true });
const calendarOne = z.object({ eventId: idSchema, title: z.string(), startsAt: iso, allDay: z.boolean(), location: z.string().nullable() });
export const notificationDataSchemas = {
  calendar_d1: calendarOne,
  calendar_d0: calendarOne,
  calendar_digest: z.object({ window: z.enum(['d1', 'd0']), date: localDateSchema, count: z.number().int().min(2), eventIds: z.array(idSchema).min(2) }),
  review_reminder: z.object({ cards: z.number().int().min(1) }),
  map_ready: z.object({ boardId: idSchema, title: z.string(), cards: z.number().int().nonnegative() }),
  referral_reward: z.object({ referralId: idSchema, role: z.enum(['referrer', 'referee']) }),
  support_reply: z.object({ ticketId: idSchema, ticketNumber: z.number().int().positive() }),
  purchase: z.object({ planName: z.string(), orderId: z.string() }),
  waitlist_joined: z.object({ interest: z.array(z.enum(storeInterests)).min(1) }),
  /** `last` = the notice on the final day; otherwise TRIAL_NOTICE_DAYS before `endsAt`. */
  trial_ending: z.object({ endsAt: iso, last: z.boolean() }),
} as const satisfies Record<InAppNotificationType, z.ZodTypeAny>;
export type NotificationDataMap = { [T in InAppNotificationType]: z.infer<(typeof notificationDataSchemas)[T]> };

/** calendar_digest has no row of its own: it obeys calendar_d1 or calendar_d0 by its window. */
export const notificationPrefKey = (type: NotificationType, data?: { window?: 'd1' | 'd0' }): NotificationPrefKey =>
  NOTIFICATION_TYPES[type].prefKey ?? (data?.window === 'd0' ? 'calendar_d0' : 'calendar_d1');

/** z.object with every key of `keys` required (z.record over an enum is Partial in zod 3). */
const recordOf = <K extends string, V extends z.ZodTypeAny>(keys: readonly K[], v: V) => z.object(Object.fromEntries(keys.map((k) => [k, v])) as Record<K, V>);

const base = {
  id: idSchema,
  category: notificationCategorySchema,
  /** App path to open (starts with "/"), never an absolute URL. */
  href: z.string().startsWith('/').nullable(),
  groupKey: z.string().nullable(),
  createdAt: timestampSchema,
  readAt: timestampSchema.nullable(),
};
const variant = <T extends InAppNotificationType>(type: T) => z.object({ ...base, type: z.literal(type), data: notificationDataSchemas[type] });
export const notificationSchema = z.discriminatedUnion('type', [
  variant('calendar_d1'),
  variant('calendar_d0'),
  variant('calendar_digest'),
  variant('review_reminder'),
  variant('map_ready'),
  variant('referral_reward'),
  variant('support_reply'),
  variant('purchase'),
  variant('waitlist_joined'),
]);
export type Notification = z.infer<typeof notificationSchema>;

// --- notify() ------------------------------------------------------------------
/**
 * `reference` + `type` = idempotency key (notifications unique (user_id, idempotency_key); email_deliveries (template, reference)).
 * `data` is required for in-app types; `email` (the template data, without EmailLinks) for types with a template.
 */
export type NotifyPayload<T extends NotificationType> = { reference: string; href?: string; groupKey?: string } & (T extends InAppNotificationType
  ? { data: NotificationDataMap[T] }
  : { data?: never }) &
  (T extends EmailNotificationType ? { email: EmailData<EmailTemplateOf<T>> } : { email?: never });
/** `skipEmail`: in-app only this time (map_ready when the generation took < 60 s and the person is still on the screen). */
export type NotifyOptions = { now?: Date; skipEmail?: boolean };

export type NotifyInAppOutcome = 'created' | 'duplicate' | 'disabled' | 'not_applicable';
export type NotifyEmailOutcome = 'queued' | 'duplicate' | 'disabled' | 'paused' | 'capped' | 'suppressed' | 'failed' | 'not_applicable';
export type NotifyResult = { inApp: NotifyInAppOutcome; notificationId: string | null; email: NotifyEmailOutcome; emailDeliveryId: string | null };
/**
 * CCR-035 (D-762): notices to an address without an account (referral invite, public landing waitlist). E-mail only, never a
 * notifications row; email_deliveries.user_id null; the unsubscribe token carries the D-386 address hash. Same reference rules.
 */
export const addressNoticeTypes = ['referral_invite', 'landing_waitlist', 'account', 'password_reset'] as const;
export type AddressNoticeType = (typeof addressNoticeTypes)[number];
/**
 * CCR-037 (D-795): `account` / `password_reset` also go by address. The Supabase Send Email hook runs inside GoTrue's transaction, so a
 * new user is not yet visible (notify() would not find them) and an email_deliveries FK to the uncommitted row would wait on that
 * transaction; the e-mail change also goes to the new address, which is not auth.users.email yet.
 */
export const ADDRESS_NOTICES = {
  referral_invite: { email: 'referral-invite' },
  landing_waitlist: { email: 'landing-waitlist' },
  account: { email: 'account-confirm' },
  password_reset: { email: 'password-reset' },
} as const satisfies Record<AddressNoticeType, { email: EmailTemplate }>;
export type NotifyAddressPayload<T extends AddressNoticeType> = { reference: string; email: EmailData<(typeof ADDRESS_NOTICES)[T]['email']> };
export type NotifyAddressResult = { email: NotifyEmailOutcome; emailDeliveryId: string | null };

/** Bundled shape for queues/jobs that pass one object around. */
export type NotifyInput = { [T in NotificationType]: { userId: string; type: T; payload: NotifyPayload<T> } }[NotificationType];

// --- HTTP: /v1/notifications (requireUser) ------------------------------------
/** GET /v1/notifications — newest first, NOTIFICATIONS_PAGE_SIZE per page; dismissed never returned. */
export const notificationListQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  /** Tabs "Todas / Não lidas" and the "Só não lidas" switch. */
  filter: z.enum(['all', 'unread']).default('all'),
  category: notificationCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(NOTIFICATIONS_PAGE_SIZE),
});
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;
export const notificationPageSchema = z.object({ items: z.array(notificationSchema), nextCursor: z.string().nullable() });
export type NotificationPage = z.infer<typeof notificationPageSchema>;

/** GET /v1/notifications/unread-count — bell badge and chip counts. */
export const unreadCountSchema = z.object({
  total: z.number().int().nonnegative(),
  byCategory: recordOf(notificationCategories, z.number().int().nonnegative()),
});
export type UnreadCount = z.infer<typeof unreadCountSchema>;

/** POST /v1/notifications/read — some ids (only the caller's count) or everything. */
export const markReadInputSchema = z.union([z.object({ ids: z.array(idSchema).min(1).max(100) }).strict(), z.object({ all: z.literal(true) }).strict()]);
export type MarkReadInput = z.infer<typeof markReadInputSchema>;
export const markReadResultSchema = z.object({ updated: z.number().int().nonnegative(), unread: z.number().int().nonnegative() });
export type MarkReadResult = z.infer<typeof markReadResultSchema>;
// DELETE /v1/notifications/:id — sets dismissed_at ("Remover"); `null` data; another user's id = not_found.

/** Stored as user_preferences.reminder_hour (7 | 8 | 12 | 20), D-744. */
export const reviewReminderTimes = ['07:00', '08:00', '12:00', '20:00'] as const;
export const reviewReminderTimeSchema = z.enum(reviewReminderTimes);
export type ReviewReminderTime = z.infer<typeof reviewReminderTimeSchema>;
export const reviewReminderHour = (t: ReviewReminderTime) => Number(t.slice(0, 2)) as 7 | 8 | 12 | 20;
export const reviewReminderTimeOf = (hour: number): ReviewReminderTime => reviewReminderTimes.find((t) => reviewReminderHour(t) === hour) ?? '20:00';

const channelsSchema = z.object({ inApp: z.boolean(), email: z.boolean() });
/** GET /v1/notifications/prefs — effective values (row or default); 'none' channels read false, 'fixed' read true. Also used by Minha conta › E-mails. */
export const notificationPrefsSchema = z.object({
  matrix: recordOf(notificationPrefKeys, channelsSchema),
  /** user_preferences.notif_pause_reminders: stops the e-mail of every `pausable` row. */
  pauseReminders: z.boolean(),
  reviewReminderTime: reviewReminderTimeSchema,
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** PATCH /v1/notifications/prefs — one or more changes; returns NotificationPrefs. Fixed or absent channels are `validation`. */
export const notificationPrefsPatchSchema = z
  .object({
    pref: z.object({ key: notificationPrefKeySchema, channel: z.enum(['inApp', 'email']), value: z.boolean() }).optional(),
    pauseReminders: z.boolean().optional(),
    reviewReminderTime: reviewReminderTimeSchema.optional(),
  })
  .strict()
  .refine((v) => v.pref !== undefined || v.pauseReminders !== undefined || v.reviewReminderTime !== undefined, 'empty patch')
  .refine((v) => !v.pref || !['fixed', 'none'].includes(NOTIFICATION_PREFS[v.pref.key][v.pref.channel]), { message: 'channel is fixed or not offered', path: ['pref'] });
export type NotificationPrefsPatch = z.infer<typeof notificationPrefsPatchSchema>;

/** Effective channels for a key from its stored row (or none). The one implementation server and tests share. */
export const effectivePref = (key: NotificationPrefKey, row: { inApp: boolean; email: boolean } | null): { inApp: boolean; email: boolean } => {
  const d = NOTIFICATION_PREFS[key];
  const pick = (s: ChannelState, stored: boolean | undefined) => (s === 'none' ? false : s === 'fixed' ? true : (stored ?? s === 'on'));
  return { inApp: pick(d.inApp, row?.inApp), email: pick(d.email, row?.email) };
};
