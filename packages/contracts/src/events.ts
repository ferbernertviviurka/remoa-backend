import { z } from 'zod';
import { areas, boardAccess, cardTypes, challengeModes, grades, inputKinds, plans, sessionKinds, verdicts } from './enums';
import { paywallReasons, billingPeriods, paymentMethods } from './billing';
import { disputeOutcomes } from './editorial';
import { segments, startPaths } from './onboarding';
import { friendStatuses, referralEntryPoints, referralRejectReasons, referralShareChannels, referralSides } from './referral';
import { supportTicketTypes } from './support';
import { calendarReminderKinds, calendarSystemLabels, calendarViews } from './calendar';
import { notificationPrefKeys, notificationTypes } from './notifications';
import { aiStatuses } from './ai';
import { accountSections, completenessItems, identityProviders, passwordLabels, preferencesSchema, reminderHourSchema, themes } from './account';

// Rule (F11): events carry counts and enums only, never answer text or card content.
// Every schema is .strict() so an extra (free-text) prop fails validation.
const none = z.object({}).strict();
const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();
const authMethod = z.enum(['password', 'magic_link', 'google']);
const upgradeSources = ['account_plan', 'usage_nudge', 'navbar_upgrade', 'plan_popover', 'map_slider_lock', 'library_lock', 'header_new_map_lock', 'referral'] as const;
/** F15 `/planos?de=`: an upgrade_clicked source, a paywall reason, or 'direct' (missing or unknown `de`). */
export const plansFromSources = [...upgradeSources, ...paywallReasons, 'direct'] as const;

export const eventSchemas = {
  // F00
  signup: z.object({ method: authMethod }).strict(),
  login: z.object({ method: authMethod }).strict(),
  theme_toggled: z.object({ theme: z.enum(['light', 'dark']) }).strict(),
  // F01
  board_created: none,
  card_created: z.object({ type: z.enum(cardTypes), origin: z.enum(['manual', 'ai', 'import']) }).strict(),
  edge_created: z.object({ hasLabel: z.boolean() }).strict(),
  heat_toggled: z.object({ enabled: z.boolean() }).strict(),
  board_opened: z.object({ cards: count, edges: count }).strict(),
  // F02
  card_edited: z.object({ type: z.enum(cardTypes) }).strict(),
  image_uploaded: z.object({ sizeKb: z.number().nonnegative() }).strict(),
  mask_created: none,
  flow_step_added: none,
  // F03
  review_completed: z
    .object({ grade: z.enum(grades), mode: z.enum(challengeModes), inputKind: z.enum(inputKinds), overridden: z.boolean() })
    .strict(),
  queue_opened: z.object({ due: count, new: count, weak: count }).strict(),
  // F21 FR-19 (G15, D-644): /app/revisar; counts and enums only, never card text
  revisar_opened: z.object({ due: count, new: count, weak: count }).strict(),
  revisar_session_started: z.object({ count, reasons: z.array(z.enum(['due', 'new', 'weak'])), maps: count, ahead: z.boolean(), area: z.enum(areas).nullable() }).strict(),
  revisar_chart_interacted: z.object({ chart: z.enum(['forecast', 'states', 'retention', 'activity']) }).strict(),
  revisar_area_clicked: z.object({ area: z.enum(areas) }).strict(),
  revisar_hard_card_opened: none,
  // F04
  challenge_started: z.object({ kind: z.enum(sessionKinds), items: count, modes: z.array(z.enum(challengeModes)) }).strict(),
  answer_submitted: z
    .object({ mode: z.enum(challengeModes), inputKind: z.enum(inputKinds), verdict: z.enum(verdicts).nullable(), latencyMs: ms })
    .strict(),
  grade_overridden: none,
  answer_disputed: none,
  challenge_finished: z.object({ correct: count, wrong: count, durationMs: ms }).strict(),
  // F04 / F08
  paywall_viewed: z.object({ reason: z.enum(paywallReasons) }).strict(),
  // F05
  ai_graded: z.object({ verdict: z.enum(verdicts), latencyMs: ms, costCents: z.number().nonnegative(), model: z.string().min(1).max(64) }).strict(),
  // G22 (CCR-071): server only (log line with `event`), never prompt, answer or card text
  ai_call: z.object({ fn: z.enum(['grade', 'rubric', 'extract']), model: z.string().min(1).max(80), latencyMs: ms, status: z.enum(aiStatuses) }).strict(),
  ai_error: z.object({ fn: z.enum(['grade', 'rubric', 'extract']), type: z.string().regex(/^[a-z_]{1,40}$/) }).strict(),
  // G22 (CCR-072): client; no user content (code = AiErrorCode)
  ai_error_shown: z.object({ code: z.string().regex(/^[a-z_]{1,40}$/) }).strict(),
  ai_grade_flagged: none,
  board_generated_from_pdf: z.object({ pages: count, cards: count, edges: count, durationMs: ms }).strict(),
  rubric_generated: none,
  // F06
  // F17 adds area, matrixItems (count), access, adjusted ("Ajustar importação" opened) and target.
  anki_imported: z
    .object({
      decks: count, cards: count, media: count, durationMs: ms, skipped: count,
      area: z.enum(areas), matrixItems: count, access: z.enum(boardAccess), adjusted: z.boolean(), target: z.enum(['new', 'existing']),
    })
    .strict(),
  anki_import_adjust_opened: none,
  // F07 (F17: counts, since a board takes up to 10 items)
  coverage_viewed: none,
  board_linked_to_matrix: z.object({ count, suggestedCount: count }).strict(),
  // F17 sharing (never title, token, password, IP or owner id)
  board_access_changed: z.object({ from: z.enum(boardAccess), to: z.enum(boardAccess), source: z.enum(['create', 'editor', 'properties']) }).strict(),
  board_share_rotated: none,
  board_share_password_changed: none,
  shared_board_viewed: z.object({ access: z.enum(['password', 'public']), cards: count }).strict(),
  shared_board_unlock_failed: none,
  shared_board_unlocked: none,
  board_copied_from_link: z.object({ access: z.enum(['password', 'public']), cards: count, blockedByQuota: z.boolean() }).strict(),
  // F08 (`plan` is a standard prop, so the checkout interval is `period`)
  // F15 adds `coupon` (optional so F08 callers stay valid; F15 always sends it). checkout_completed = subscription_started (server, from the webhook).
  checkout_started: z.object({ period: z.enum(billingPeriods), method: z.enum(paymentMethods), coupon: z.boolean().optional() }).strict(),
  subscription_started: none,
  subscription_canceled: none,
  account_exported: none,
  account_deleted: none,
  // F09
  pwa_installed: none,
  voice_used: z.object({ success: z.boolean() }).strict(),
  offline_answer_synced: none,
  // F10
  card_approved: none,
  version_published: none,
  seed_board_copied: none,
  dispute_resolved: z.object({ outcome: z.enum(disputeOutcomes) }).strict(),
  // F11
  progress_viewed: none,
  // G16 store waitlist (FR-13): never e-mail or other PII in props
  store_viewed: none,
  store_waitlist_joined: z.object({ interest: z.enum(['buy', 'sell', 'both']), role: z.enum(['teacher', 'student_resident', 'physician']).nullable() }).strict(),
  store_sell_cta_clicked: none,
  store_simulator_used: z.object({ band: z.enum(['low', 'mid', 'high']) }).strict(),
  store_faq_opened: z.object({ item: z.number().int().min(0).max(20) }).strict(),
  // F12
  waitlist_joined: z.object({ variant: z.string().regex(/^\d+$/).nullable(), segment: z.enum(segments) }).strict(),
  onboarding_step: z.object({ step: z.number().int().min(1).max(4) }).strict(),
  onboarding_completed: z.object({ path: z.enum([...startPaths, 'blank', 'skipped']) }).strict(),
  demo_started: none,
  // F13 (no name, e-mail or free text)
  account_viewed: z.object({ section: z.enum(accountSections) }).strict(),
  avatar_changed: z.object({ source: z.enum(['upload', 'initials', 'removed']), zoom: z.number().min(100).max(200).nullable() }).strict(),
  profile_name_changed: none,
  email_change_requested: none,
  email_change_confirmed: none,
  password_changed: z.object({ strength: z.enum(passwordLabels) }).strict(),
  identity_linked: z.object({ provider: z.enum(identityProviders) }).strict(),
  identity_unlinked: z.object({ provider: z.enum(identityProviders) }).strict(),
  session_revoked: z.object({ count }).strict(),
  preference_changed: z
    .object({ key: preferencesSchema.keyof(), value: z.union([z.boolean(), z.number().int(), z.enum(themes)]).nullable() })
    .strict(),
  reminder_enabled: z.object({ hour: reminderHourSchema }).strict(),
  export_requested: none,
  export_downloaded: none,
  deletion_requested: none,
  deletion_canceled: none,
  upgrade_clicked: z.object({ source: z.enum(upgradeSources) }).strict(),
  // F14
  plan_popover_opened: z.object({ trigger: z.enum(['hover', 'click', 'keyboard']) }).strict(),
  map_slider_navigated: z.object({ direction: z.enum(['prev', 'next']), index: z.number().int().nonnegative() }).strict(),
  map_slide_clicked: z.object({ kind: z.enum(['map', 'new', 'locked']) }).strict(),
  completeness_chip_clicked: z.object({ item: z.enum(completenessItems) }).strict(),
  // F15 (`plan` is a base prop; never the coupon code)
  plans_viewed: z.object({ from: z.enum(plansFromSources) }).strict(),
  plans_period_changed: z.object({ period: z.enum(billingPeriods) }).strict(),
  plans_method_selected: z.object({ method: z.enum(paymentMethods) }).strict(),
  coupon_applied: none,
  coupon_failed: none,
  checkout_redirected: z.object({ period: z.enum(billingPeriods), method: z.enum(paymentMethods) }).strict(),
  checkout_canceled: none,
  checkout_pending_pix: none,
  faq_opened: z.object({ index: z.number().int().min(0).max(9) }).strict(),
  plans_manage_clicked: none,
  plans_annual_switch_clicked: none,
  // F16 landing (no personal data: referrer is a hostname, utm values are campaign labels)
  landing_viewed: z
    .object({
      variant: z.enum(['29', '49']).nullable(),
      h1: z.enum(['a', 'b', 'c']),
      utm_source: z.string().max(80).nullable(),
      utm_medium: z.string().max(80).nullable(),
      utm_campaign: z.string().max(120).nullable(),
      referrer: z.string().max(120).nullable(),
    })
    .strict(),
  hero_cta_clicked: z.object({ cta: z.enum(['create', 'demo']) }).strict(),
  landing_cta_clicked: z
    .object({
      location: z.enum(['header', 'demo', 'plans_free', 'plans_pro', 'plans_founder', 'final']),
      cta: z.enum(['create', 'waitlist', 'signin', 'open_app']),
    })
    .strict(),
  hero_replayed: none,
  feature_tab_selected: z.object({ feature: z.enum(['map', 'cards', 'challenge', 'grading', 'fsrs', 'enamed']) }).strict(),
  demo_answered: z.object({ correct: z.boolean() }).strict(),
  demo_completed: none,
  pricing_toggled: z.object({ period: z.enum(['monthly', 'annual']) }).strict(),
  pricing_viewed: none,
  // F18 referral (never e-mail, name or code; D-388). referral_qualified / referral_reward_granted / referral_rejected and
  // first_board_created are emitted by the server.
  referral_page_viewed: z.object({ from: z.enum(referralEntryPoints) }).strict(),
  referral_link_copied: none,
  referral_message_edited: none,
  referral_share_clicked: z.object({ channel: z.enum(referralShareChannels) }).strict(),
  referral_invites_sent: z.object({ count: z.number().int().min(1).max(5) }).strict(),
  referral_friend_selected: z.object({ status: z.enum(friendStatuses) }).strict(),
  referral_invite_opened: z.object({ valid: z.boolean() }).strict(),
  referral_signup: z.object({ valid: z.boolean(), method: authMethod }).strict(),
  referral_qualified: none,
  referral_reward_granted: z.object({ side: z.enum(referralSides), kind: z.enum(['month', 'credit']) }).strict(),
  referral_reward_seen: none,
  referral_rejected: z.object({ reason: z.enum(referralRejectReasons) }).strict(),
  // F19 support (D-433): no subject, description or context text, only enums/booleans. Admin actions are never tracked.
  support_opened: z.object({ from: z.enum(['fab', 'command', 'account_menu', 'mobile_nav', 'email_link']) }).strict(),
  support_submitted: z.object({ type: z.enum(supportTicketTypes), hasAttachment: z.boolean(), context: z.boolean() }).strict(),
  support_replied: none,
  support_ticket_resolved: z.object({ type: z.enum(supportTicketTypes) }).strict(),
  first_board_created: none,
  scroll_depth: z.object({ depth: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]) }).strict(),
  // G18 F26 central de notificações (CCR-036): counts and enums only, never the notice text.
  notif_bell_opened: z.object({ unread: count }).strict(),
  notif_clicked: z.object({ type: z.enum(notificationTypes) }).strict(),
  notif_marked_read: z.object({ scope: z.enum(['one', 'all']) }).strict(),
  notif_removed: none,
  notif_pref_changed: z.object({ key: z.enum(notificationPrefKeys), channel: z.enum(['in_app', 'email']), value: z.boolean() }).strict(),
  notif_pause_toggled: z.object({ on: z.boolean() }).strict(),
  // G18 F25 calendário FR-26 (CCR-036): never the title, place or description.
  calendar_opened: z.object({ view: z.enum(calendarViews) }).strict(),
  calendar_view_changed: z.object({ view: z.enum(calendarViews) }).strict(),
  calendar_event_created: z.object({ hasImage: z.boolean(), hasLocation: z.boolean(), label: z.enum([...calendarSystemLabels, 'custom']) }).strict(),
  calendar_event_edited: z.object({ hasImage: z.boolean(), hasLocation: z.boolean() }).strict(),
  calendar_event_deleted: none,
  calendar_label_created: none,
  calendar_label_toggled: z.object({ visible: z.boolean() }).strict(),
  calendar_tour_step: z.object({ step: z.number().int().min(1).max(5) }).strict(),
  calendar_tour_finished: z.object({ how: z.enum(['finish', 'skip', 'create']) }).strict(),
  calendar_reminder_toggled: z.object({ kind: z.enum(calendarReminderKinds), on: z.boolean() }).strict(),
  calendar_home_card_clicked: z.object({ target: z.enum(['banner', 'card']) }).strict(),
  // G19 F25 blog and legal pages (CCR-045, CCR-047): never post text or the search term (D-938).
  blog_post_viewed: z.object({ slug: z.string().min(1).max(120), template: z.string().min(1).max(40), category: z.string().min(1).max(120).optional() }).strict(),
  blog_cta_clicked: z.object({ slug: z.string().min(1).max(120), position: z.string().min(1).max(40) }).strict(),
  blog_search_used: z.object({ resultCount: count, queryLength: count }).strict(),
  landing_blog_clicked: z.object({ position: z.number().int().min(0).max(4) }).strict(),
  legal_page_viewed: z.object({ document: z.enum(['terms', 'privacy']) }).strict(),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventProps = { [E in EventName]: z.infer<(typeof eventSchemas)[E]> };
export const eventNames = Object.keys(eventSchemas) as EventName[];

/** Added by `track()` to every event (F11 FR-4); callers never pass these. */
export const baseEventPropsSchema = z.object({
  plan: z.enum(plans),
  boardId: z.string().uuid().optional(),
  area: z.enum(areas).optional(),
  platform: z.enum(['web', 'pwa']),
  appVersion: z.string(),
});
export type BaseEventProps = z.infer<typeof baseEventPropsSchema>;

export type Track = <E extends EventName>(event: E, props: EventProps[E]) => void;
