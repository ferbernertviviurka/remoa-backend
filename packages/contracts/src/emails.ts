// G18 / F24 e-mails (CCR-034, D-736–D-738; CCR-035, D-760). Catalog of the 8 F24 templates (11 versions) plus the 10 that replace the legacy plain-text notices, classes and data.
// Data keys are camelCase English (code convention); the F24 / docs/design/v2/emails `{{variável}}` names map 1:1 (see each schema).
// Values are raw (cents, ISO instants, IANA timezone): `@remoa/emails` formats them in pt-BR, so no caller formats dates or money.
// Links that depend on the class (preferences, unsubscribe, pause) are NOT in the data: `sendEmail` adds them as `EmailLinks`.
import { z } from 'zod';
import { paymentMethods } from './billing';
import { storeSellerRoles } from './store';
import { calendarColorSchema } from './calendar';

export const emailTemplates = [
  'account-confirm',
  'purchase-success',
  'password-reset',
  'calendar-reminder',
  'inactivity',
  'review-reminder',
  'map-ready',
  'waitlist-confirm',
  // CCR-035 (D-760): every product e-mail comes from @remoa/emails (rule 10); these replace the legacy plain-text copies.
  'support-reply',
  'referral-reward',
  'referral-invite',
  'password-changed',
  'welcome',
  'onboarding-nudge',
  'payment-receipt',
  'admin-alert',
  'dispute-resolved',
  'landing-waitlist',
  'trial-ending',
] as const;
export const emailTemplateSchema = z.enum(emailTemplates);
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

/** Templates with versions; the version travels inside the data as `version`. */
export const EMAIL_VERSIONS = {
  'account-confirm': ['signup', 'email_change', 'magiclink'],
  'calendar-reminder': ['d1', 'd0', 'varios'],
  'waitlist-confirm': ['comprar', 'vender'],
  'support-reply': ['received', 'answered'],
  'referral-reward': ['referrer', 'referee'],
  'onboarding-nudge': ['first_map', 'day3'],
  'admin-alert': ['export_users', 'export_payments'],
  'trial-ending': ['d3', 'd0'],
} as const satisfies Partial<Record<EmailTemplate, readonly string[]>>;

/** transactional = always sent (map-ready still honours its preference); reminder and list = preferences, unsubscribe link and List-Unsubscribe. */
export const emailClasses = ['transactional', 'reminder', 'list'] as const;
export const emailClassSchema = z.enum(emailClasses);
export type EmailClass = z.infer<typeof emailClassSchema>;

export const EMAIL_CLASS: Record<EmailTemplate, EmailClass> = {
  'account-confirm': 'transactional',
  'purchase-success': 'transactional',
  'password-reset': 'transactional',
  'calendar-reminder': 'reminder',
  inactivity: 'reminder',
  'review-reminder': 'reminder',
  'map-ready': 'transactional',
  'waitlist-confirm': 'list',
  'support-reply': 'transactional',
  'referral-reward': 'transactional',
  'referral-invite': 'list',
  'password-changed': 'transactional',
  welcome: 'transactional',
  'onboarding-nudge': 'reminder',
  'payment-receipt': 'transactional',
  'admin-alert': 'transactional',
  'dispute-resolved': 'transactional',
  'landing-waitlist': 'list',
  'trial-ending': 'transactional',
};

/** email_deliveries.status. queued → sent → delivered | delivery_delayed | bounced | complained; failed after the 3 tries; suppressed = never sent. */
export const emailStatuses = ['queued', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed'] as const;
export const emailStatusSchema = z.enum(emailStatuses);
export type EmailStatus = z.infer<typeof emailStatusSchema>;

/** email_suppressions.reason. invite_opt_out (F18) only stops referral invites; hard_bounce and complaint stop reminder and list mail (transactional still goes). */
export const emailSuppressionReasons = ['invite_opt_out', 'hard_bounce', 'complaint'] as const;
export type EmailSuppressionReason = (typeof emailSuppressionReasons)[number];

const url = z.string().url();
const iso = z.string().datetime({ offset: true });
const tz = z.string().min(1).max(64);
const count = z.number().int().nonnegative();
const name = z.string().trim().min(1).max(80).nullable();

/** 1 · {{nome}} {{confirmUrl}} — sent by the Supabase Send Email hook (signup/invite, email_change; magiclink = passwordless sign-in link, CCR-037). */
export const accountConfirmDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['account-confirm']), name, confirmUrl: url });
/** 2 · {{nome}} {{plano}} {{valor}} {{metodo}} {{dataPedido}} {{proximaCobranca}} {{pedido}} {{assinaturaUrl}} — values from Stripe (D-023). */
export const purchaseSuccessDataSchema = z.object({
  name,
  planName: z.string().min(1).max(60),
  amountCents: count,
  currency: z.literal('BRL'),
  method: z.enum(paymentMethods),
  paidAt: iso,
  nextChargeAt: iso.nullable(),
  orderId: z.string().min(1).max(80),
  manageUrl: url,
  timezone: tz,
});
/** 3 · {{email}} {{resetUrl}} {{dispositivo}} {{dataPedido}} */
export const passwordResetDataSchema = z.object({ email: z.string().email(), resetUrl: url, device: z.string().max(120).nullable(), requestedAt: iso, timezone: tz });

const calendarItem = z.object({
  eventId: z.string().uuid(),
  title: z.string().min(1).max(120),
  labelName: z.string().min(1).max(40),
  labelColor: calendarColorSchema,
  startsAt: iso,
  endsAt: iso.nullable(),
  allDay: z.boolean(),
  location: z.string().max(160).nullable(),
});
/**
 * 4 · d1/d0: {{titulo}} {{etiqueta}} {{dataLonga}} {{hora}} {{local}} {{descricao}} {{capaUrl}} {{calendarioUrl}} {{icsUrl}} {{cardsVencidos}} {{revisarUrl}};
 * varios: {{nome}} {{dataLonga}} {{calendarioUrl}} + the list of events. `window` says whether "varios" is the eve (d1) or the day (d0) digest.
 */
export const calendarReminderDataSchema = z.discriminatedUnion('version', [
  calendarItem.extend({
    version: z.enum(['d1', 'd0']),
    timezone: tz,
    description: z.string().max(2000).nullable(),
    coverUrl: url.nullable(),
    calendarUrl: url,
    icsUrl: url,
    dueCards: count,
    reviewUrl: url,
  }),
  z.object({ version: z.literal('varios'), window: z.enum(['d1', 'd0']), name, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: tz, events: z.array(calendarItem).min(2).max(20), calendarUrl: url }),
]);
/** 5 · {{nome}} {{dias}} {{cardsVencidos}} {{mapas}} {{proximoCompromisso}} {{retomarUrl}} ({{pausarUrl}} comes from EmailLinks). */
export const inactivityDataSchema = z.object({
  name,
  days: z.number().int().min(1),
  dueCards: count,
  maps: count,
  nextEvent: z.object({ title: z.string().min(1).max(120), startsAt: iso, allDay: z.boolean() }).nullable(),
  timezone: tz,
  resumeUrl: url,
});
/** 6 · {{cards}} {{cardsVencidos}} {{novos}} {{minutos}} {{mapa1}} {{mapa1Cards}}… {{revisarUrl}} */
export const reviewReminderDataSchema = z.object({
  name,
  cards: z.number().int().min(1),
  overdue: count,
  newCards: count,
  minutes: z.number().int().min(1),
  maps: z.array(z.object({ title: z.string().min(1).max(120), cards: count })).max(3),
  reviewUrl: url,
});
/** 7 · {{mapa}} {{cards}} {{conexoes}} {{origem}} {{mapaUrl}} */
export const mapReadyDataSchema = z.object({ mapTitle: z.string().min(1).max(120), cards: count, connections: count, origin: z.enum(['text', 'pdf', 'anki']), mapUrl: url });
/** 8 · {{nome}} {{perfil}} {{lojaUrl}} ({{sairListaUrl}} = EmailLinks.unsubscribeUrl). `sellerRole` only in "vender". */
export const waitlistConfirmDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['waitlist-confirm']), name, sellerRole: z.enum(storeSellerRoles).nullable(), storeUrl: url });

// CCR-035 (D-760, D-761): legacy notices moved into the package. Text lives in @remoa/emails; data stays raw.
/** support-reply · received (ticket opened) | answered (team replied). */
export const supportReplyDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['support-reply']), name, ticketNumber: z.number().int().positive(), ticketUrl: url });
/** referral-reward · referrer (a friend qualified) | referee (your first map qualified the invite). `friendName` = the other side. */
export const referralRewardDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['referral-reward']), name, friendName: name, dashboardUrl: url });
/** referral-invite · to an address without an account (notifyAddress); the unsubscribe link suppresses future invites. */
export const referralInviteDataSchema = z.object({ referrerName: z.string().trim().min(1).max(80), inviteUrl: url });
/** password-changed · security notice after a password change. */
export const passwordChangedDataSchema = z.object({ name, changedAt: iso, timezone: tz, resetUrl: url });
/** welcome · once, after the onboarding answers are saved (F12 FR-8). */
export const welcomeDataSchema = z.object({ name, startUrl: url });
/** onboarding-nudge · first_map (first board reached 20 cards) | day3 (no session after 3 days). Obeys the inactivity row. */
export const onboardingNudgeDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['onboarding-nudge']), name, actionUrl: url });
/** payment-receipt · admin "Reenviar recibo" (F19 FR-16): the Stripe receipt link. */
export const paymentReceiptDataSchema = z.object({ name, receiptUrl: url });
/** admin-alert · to every admin when users or payments are exported (F19 FR-21). */
export const adminAlertDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['admin-alert']), name, count, at: iso, timezone: tz, auditUrl: url });
/** dispute-resolved · a reviewer decided on the student's rubric dispute (F07). */
export const disputeResolvedDataSchema = z.object({ name });
/** landing-waitlist · public landing waitlist (no account, notifyAddress). */
export const landingWaitlistDataSchema = z.object({});
/** trial-ending · d3 (TRIAL_NOTICE_DAYS before) | d0 (last day) of the free Pro trial (D-1213). {{nome}} {{dataFim}} {{planosUrl}} */
export const trialEndingDataSchema = z.object({ version: z.enum(EMAIL_VERSIONS['trial-ending']), name, endsAt: iso, timezone: tz, plansUrl: url });

export const emailDataSchemas = {
  'account-confirm': accountConfirmDataSchema,
  'purchase-success': purchaseSuccessDataSchema,
  'password-reset': passwordResetDataSchema,
  'calendar-reminder': calendarReminderDataSchema,
  inactivity: inactivityDataSchema,
  'review-reminder': reviewReminderDataSchema,
  'map-ready': mapReadyDataSchema,
  'waitlist-confirm': waitlistConfirmDataSchema,
  'support-reply': supportReplyDataSchema,
  'referral-reward': referralRewardDataSchema,
  'referral-invite': referralInviteDataSchema,
  'password-changed': passwordChangedDataSchema,
  welcome: welcomeDataSchema,
  'onboarding-nudge': onboardingNudgeDataSchema,
  'payment-receipt': paymentReceiptDataSchema,
  'admin-alert': adminAlertDataSchema,
  'dispute-resolved': disputeResolvedDataSchema,
  'landing-waitlist': landingWaitlistDataSchema,
  'trial-ending': trialEndingDataSchema,
} as const satisfies Record<EmailTemplate, z.ZodTypeAny>;
export type EmailDataMap = { [T in EmailTemplate]: z.infer<(typeof emailDataSchemas)[T]> };
export type EmailData<T extends EmailTemplate> = EmailDataMap[T];

/**
 * Added by `sendEmail`, never by the caller. `appUrl` always; reminder and list classes get `preferencesUrl` and `unsubscribeUrl`
 * ({{cancelarUrl}} / {{sairListaUrl}}, the one-click token link that is also the List-Unsubscribe URL); `pauseUrl` ({{pausarUrl}})
 * turns notif_pause_reminders on and is only set for reminder templates.
 */
export const emailLinksSchema = z.object({
  appUrl: url,
  preferencesUrl: url.optional(),
  unsubscribeUrl: url.optional(),
  pauseUrl: url.optional(),
  /** CCR-037 (P-304): "Razão social · endereço" for the footer, from EMAIL_FOOTER_LEGAL_NAME / EMAIL_FOOTER_ADDRESS when set. */
  legal: z.string().max(300).optional(),
});
export type EmailLinks = z.infer<typeof emailLinksSchema>;

/** `render(template, data, links)` in @remoa/emails. */
export type RenderedEmail = { subject: string; preheader: string; html: string; text: string };

/**
 * `sendEmail(input)`: `reference` + `template` is the idempotency key (email_deliveries unique); a repeat returns the first delivery.
 * `userId` null only for addresses without an account. Never throws into the caller's action.
 */
export type SendEmailInput<T extends EmailTemplate = EmailTemplate> = {
  template: T;
  to: string;
  data: EmailData<T>;
  reference: string;
  userId: string | null;
};
export type SendEmailResult =
  | { status: 'sent' | 'queued'; deliveryId: string; duplicate: boolean }
  | { status: 'suppressed' | 'failed'; deliveryId: string | null; reason: string };

/** Reference keys must stay short and carry no personal data (they are stored and sent to the provider as idempotency key). */
export const emailReferenceSchema = z.string().min(1).max(200).regex(/^[\w:.-]+$/);
