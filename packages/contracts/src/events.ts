import { z } from 'zod';
import { areas, cardTypes, challengeModes, grades, inputKinds, plans, sessionKinds, verdicts } from './enums';
import { paywallReasons, billingPeriods, paymentMethods } from './billing';
import { disputeOutcomes } from './editorial';
import { segments, startPaths } from './onboarding';
import { accountSections, completenessItems, identityProviders, passwordLabels, preferencesSchema, reminderHourSchema, themes } from './account';

// Rule (F11): events carry counts and enums only, never answer text or card content.
// Every schema is .strict() so an extra (free-text) prop fails validation.
const none = z.object({}).strict();
const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();
const authMethod = z.enum(['password', 'magic_link', 'google']);

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
  board_generated_from_pdf: z.object({ pages: count, cards: count, edges: count, durationMs: ms }).strict(),
  rubric_generated: none,
  // F06
  anki_imported: z.object({ decks: count, cards: count, media: count, durationMs: ms, skipped: count }).strict(),
  // F07
  coverage_viewed: none,
  board_linked_to_matrix: z.object({ suggested: z.boolean() }).strict(),
  // F08 (`plan` is a standard prop, so the checkout interval is `period`)
  checkout_started: z.object({ period: z.enum(billingPeriods), method: z.enum(paymentMethods) }).strict(),
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
  // F12
  waitlist_joined: z.object({ variant: z.string().regex(/^\d+$/).nullable(), segment: z.enum(segments) }).strict(),
  onboarding_step: z.object({ step: z.number().int().min(1).max(4) }).strict(),
  onboarding_completed: z.object({ path: z.enum([...startPaths, 'skipped']) }).strict(),
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
  upgrade_clicked: z.object({ source: z.enum(['account_plan', 'usage_nudge']) }).strict(),
  completeness_chip_clicked: z.object({ item: z.enum(completenessItems) }).strict(),
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
