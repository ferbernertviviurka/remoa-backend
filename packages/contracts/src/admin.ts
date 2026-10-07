// F19 Painel admin (CCR-011, D-425–D-434). Every route is /v1/admin/*; non-admin = 404 (never 403), D-421.
// Enum arrays are the single source for zod here and pgEnum/checks in @remoa/db.
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { areas, boardStatuses, plans, profileRoles } from './enums';
import { boardGraphSchema } from './board';
import { paymentMethods } from './billing';
import { referralChannels, referralRejectReasons } from './referral';
import { segmentSchema } from './onboarding';
import { supportAuthorTypes, supportAttachmentSchema, supportContextSchema, supportTicketStatuses, supportTicketTypes } from './support';

// --- enums ------------------------------------------------------------------------------
/** `payments.method`: `credit` = paid entirely by Stripe customer balance (F18 referral credit). */
export const paymentRecordMethods = [...paymentMethods, 'credit'] as const;
export const paymentStatuses = ['paid', 'pending', 'failed', 'refunded'] as const;
/** `payments.item` (text column): what was bought. */
export const paymentItems = ['pro_monthly', 'pro_annual', 'founder_lifetime'] as const;
/** FR-16 drawer timeline, appended by the webhook (D-428). */
export const paymentEventTypes = ['checkout_created', 'pix_generated', 'card_authorized', 'paid', 'plan_released', 'failed', 'refund_requested', 'refunded', 'marked_paid'] as const;
/** `user` = a non-admin caller of /v1/admin/* (logged as denied, D-430). */
export const auditActorTypes = ['admin', 'user', 'system', 'stripe'] as const;
export const auditResults = ['success', 'denied'] as const;
/** Why a call was denied (audit `denial`). */
export const auditDenials = ['not_admin', 'reauth_required', 'missing_reason', 'invalid_state', 'error'] as const;
/** Every value of `admin_audit_log.action` written by the panel (text column; this list is the contract). */
export const adminActions = [
  'user.grant_pro_month', 'user.password_reset', 'user.suspend', 'user.reactivate', 'user.schedule_deletion',
  'map.open_readonly', 'map.archive', 'seed.approve', 'seed.unpublish',
  'payment.refund', 'payment.mark_paid', 'payment.resend_receipt',
  'referral.approve', 'referral.reject', 'grant.revoke',
  'ticket.reply', 'ticket.internal_note', 'ticket.assign', 'ticket.resolve',
  'export.csv',
  /** Denied hit on any /v1/admin/* route by a non-admin (target = the path). */
  'admin.access',
  /** Written by the Stripe webhook / system jobs, not by withAdmin. */
  'payment.webhook', 'referral.auto_reject',
  /** `pnpm db:make-admin <email>` (actor system). */
  'user.make_admin',
  /** CCR-020: every GET /v1/admin/waitlist (e-mails are PII). Reason = ADMIN_AUTO_REASONS.waitlistView, target route. */
  'waitlist.view',
  /** CCR-030: every GET /v1/admin/store-waitlist (counts only). Reason = ADMIN_AUTO_REASONS.storeWaitlistView, target route. */
  'store_waitlist.view',
  /** CCR-040 (G19 blog). unpublish/delete take a typed reason; the rest use BLOG_AUTO_REASONS (contracts/blog). */
  'blog.create', 'blog.update', 'blog.duplicate', 'blog.publish', 'blog.schedule', 'blog.unpublish', 'blog.delete',
  'blog.restore_revision', 'blog.upload_image', 'blog.category_upsert', 'blog.preview_link', 'sitemap.regenerate',
  /** Written by the blog.publish-scheduled job (actor system), not by withAdmin. */
  'blog.auto_publish',
] as const;
export const auditTargetTypes = ['user', 'board', 'payment', 'referral', 'grant', 'ticket', 'export', 'route', 'blog_post', 'blog_category', 'blog_asset', 'sitemap'] as const;
/** List filters. `deleting` = account in the 7-day grace (F13); `pending` = e-mail not confirmed. */
export const adminUserStatuses = ['active', 'pending', 'suspended', 'deleting'] as const;
export const adminUserOrigins = ['direct', 'referral'] as const;
/** Derived on read (no column): seed copy = source_board_id, link copy = copied_from_link_at, import = imports row. */
export const adminMapOrigins = ['manual', 'import', 'seed_copy', 'link_copy', 'seed'] as const;
export const adminMapStatuses = [...boardStatuses, 'archived'] as const;
/** Admin view of a referral: `in_review` = rejected by velocity_limit/fraud_signals, awaiting a manual decision (P-190). */
export const adminReferralStatuses = ['invited', 'signed_up', 'qualified', 'in_review', 'rejected', 'expired'] as const;
export const overviewPeriods = [7, 30, 90] as const;
export const adminExportResources = ['overview', 'users', 'payments', 'audit', 'maps', 'referrals', 'waitlist', 'store_waitlist'] as const;
/** "Plano" filter chips (CCR-014): `pro_grant` = Pro from a running grant ("Pro por indicação"), i.e. `grantUntil` not null. */
export const adminUserPlanFilters = [...plans, 'pro_grant'] as const;

export type PaymentRecordMethod = (typeof paymentRecordMethods)[number];
export type PaymentStatus = (typeof paymentStatuses)[number];
export type PaymentItem = (typeof paymentItems)[number];
export type PaymentEventType = (typeof paymentEventTypes)[number];
export type AuditActorType = (typeof auditActorTypes)[number];
export type AuditResult = (typeof auditResults)[number];
export type AuditDenial = (typeof auditDenials)[number];
export type AdminAction = (typeof adminActions)[number];
export type AuditTargetType = (typeof auditTargetTypes)[number];
export type OverviewPeriod = (typeof overviewPeriods)[number];

export const ADMIN_LIMITS = {
  pageSize: 25,
  pageSizeMax: 100,
  reasonMin: 8,
  reasonMax: 500,
  /** FR-11: sensitive actions need a sign-in this recent (amr timestamp, D-431). */
  reauthMinutes: 30,
  /** FR-11: admin session lifetime (since the last sign-in). */
  sessionHours: 12,
  overviewListSize: 5,
  /** Ticket "sem resposta" attention threshold. */
  ticketStaleHours: 24,
  /** CCR-014: AdminTicketRow.preview length cap. */
  ticketPreviewMax: 140,
} as const;

/** `AppError.message` values (generic ErrorCode in parentheses). Non-admin is plain `not_found` 'not found'. */
export const adminErrors = {
  /** forbidden — sign in again (≤ 30 min) before a sensitive action; the web shows the reauth dialog */
  reauth: 'reauth_required',
  /** conflict — e.g. refund of a non-paid payment, approve a non-in_review referral */
  invalidState: 'invalid_state',
  /** forbidden — the account is suspended (every /v1/* except GET /v1/account/me) */
  suspended: 'account_suspended',
} as const;

// --- shared pieces --------------------------------------------------------------------------
/** FR-20: every sensitive action carries a reason. */
export const reasonSchema = z.string().trim().min(ADMIN_LIMITS.reasonMin).max(ADMIN_LIMITS.reasonMax);
export const reasonInputSchema = z.object({ reason: reasonSchema });
export type ReasonInput = z.input<typeof reasonInputSchema>;

/** POST /v1/admin/seeds/:id/approve (F31, D-1522). `institutional: true` = "Aprovado por Remoa" (not physician CRM on cards). */
export const seedApproveInputSchema = reasonInputSchema.extend({ institutional: z.literal(true).optional() });
export type SeedApproveInput = z.infer<typeof seedApproveInputSchema>;

/** Query string of every list route (strings coerced). Search and filters run on the server (FR-22). */
export const adminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(ADMIN_LIMITS.pageSizeMax).default(ADMIN_LIMITS.pageSize),
  q: z.string().trim().max(120).optional(),
});
export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative(), page: z.number().int().min(1), pageSize: z.number().int().min(1) });

const cents = z.number().int();
/** Query-string boolean: only 'true'/'false' (z.coerce.boolean turns 'false' into true). */
const queryBool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true');
const count = z.number().int().nonnegative();
/** Who, as the panel shows it. null name = profile without a name. */
export const adminUserRefSchema = z.object({ id: idSchema, name: z.string().nullable(), email: z.string().nullable() });
export type AdminUserRef = z.infer<typeof adminUserRefSchema>;

// --- audit (FR-19) --------------------------------------------------------------------------
/** "a_1050" (FR-20). */
export const formatAuditId = (id: number) => `a_${id}`;
export const auditEntrySchema = z.object({
  id: z.number().int().positive(),
  createdAt: timestampSchema,
  actorType: z.enum(auditActorTypes),
  actor: adminUserRefSchema.nullable(),
  action: z.enum(adminActions),
  targetType: z.enum(auditTargetTypes).nullable(),
  targetId: z.string().nullable(),
  /** CCR-014: what the target is, as the list shows it ("Ana Costa", "Sepse e choque séptico", "#1042", "pi_…"); null = not resolved (deleted, route, export). */
  targetLabel: z.string().nullable(),
  reason: z.string().nullable(),
  result: z.enum(auditResults),
  denial: z.enum(auditDenials).nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  /** sha256 hex of IP + server salt; never the IP. */
  ipHash: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
/** Response of every action POST: the drawer shows the entry right away ("Ação registrada na auditoria (a_1050)"). */
export const adminActionResultSchema = z.object({ audit: auditEntrySchema });
export type AdminActionResult = z.infer<typeof adminActionResultSchema>;

export const auditListQuerySchema = adminListQuerySchema.extend({
  actorId: idSchema.optional(),
  /** CCR-014: "Quem" chips (admin, system, stripe). */
  actorType: z.enum(auditActorTypes).optional(),
  result: z.enum(auditResults).optional(),
  action: z.enum(adminActions).optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
});
export type AuditListQuery = z.input<typeof auditListQuerySchema>;
export const auditPageSchema = pageOf(auditEntrySchema).extend({
  /** CCR-014 chips (registros, de admins, do sistema, negados): rows matching `q`, ignoring the other filters. `system` = actorType system + stripe. */
  summary: z.object({ total: count, admin: count, system: count, denied: count }),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

// --- me (GET /v1/admin/me) -------------------------------------------------------------------
/** Used by the web middleware/layout; any failure or non-admin = notFound(). */
export const adminMeSchema = z.object({
  id: idSchema,
  name: z.string().nullable(),
  email: z.string(),
  /** Last sign-in (max amr timestamp). The web asks for reauth when now − this > reauthMinutes before an action. */
  authenticatedAt: timestampSchema,
  openTickets: count,
});
export type AdminMe = z.infer<typeof adminMeSchema>;

// --- overview (FR-13) --------------------------------------------------------------------------
export const overviewQuerySchema = z.object({ period: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30) });
export const kpiSchema = z.object({
  value: z.number(),
  /** Change vs the previous period of the same length, absolute (same unit as value). */
  delta: z.number(),
  /** CCR-014: relative change in % (revenue chip "+8%"); null when the base is 0. Base = previous period for flows, value − delta for totals. */
  deltaPct: z.number().nullable(),
  /** Mini-bars: one value per bucket of the period (same buckets as `growth`). */
  spark: z.array(z.number()),
});
export type Kpi = z.infer<typeof kpiSchema>;
export const adminOverviewSchema = z.object({
  period: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  kpis: z.object({
    accounts: kpiSchema,
    maps: kpiSchema,
    proSubscribers: kpiSchema,
    /** centavos */
    revenue: kpiSchema,
    referralsQualified: kpiSchema,
    openTickets: kpiSchema,
  }),
  /** One bucket per day (7/30) or per 3 days (90). `day` = first day of the bucket, YYYY-MM-DD. */
  growth: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accounts: count, maps: count })),
  attention: z.object({
    referralsInReview: count,
    paymentsFailed24h: count,
    ticketsStale: count,
    seedsAwaitingReview: count,
  }),
  latestPayments: z.array(z.object({ id: z.string(), user: adminUserRefSchema.nullable(), item: z.enum(paymentItems), method: z.enum(paymentRecordMethods), amountCents: cents, status: z.enum(paymentStatuses), createdAt: timestampSchema })).max(5),
  latestUsers: z.array(z.object({ user: adminUserRefSchema, plan: z.enum(plans), origin: z.enum(adminUserOrigins), createdAt: timestampSchema })).max(5),
  latestMaps: z.array(z.object({ id: idSchema, title: z.string(), area: z.enum(areas), owner: adminUserRefSchema.nullable(), cards: count, createdAt: timestampSchema })).max(5),
  generatedAt: timestampSchema,
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

// --- users (FR-14) ------------------------------------------------------------------------------
export const adminUserListQuerySchema = adminListQuerySchema.extend({
  plan: z.enum(adminUserPlanFilters).optional(),
  status: z.enum(adminUserStatuses).optional(),
});
export type AdminUserListQuery = z.input<typeof adminUserListQuerySchema>;
export const adminUserRowSchema = adminUserRefSchema.extend({
  plan: z.enum(plans),
  maps: count,
  cards: count,
  status: z.enum(adminUserStatuses),
  origin: z.enum(adminUserOrigins),
  /** CCR-014 (moved up from the detail): end of the running grant; plan 'pro' + grantUntil = "Pro por indicação". */
  grantUntil: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type AdminUserRow = z.infer<typeof adminUserRowSchema>;
export const adminUserPageSchema = pageOf(adminUserRowSchema).extend({
  summary: z.object({ total: count, active: count, pending: count, suspended: count }),
});
export type AdminUserPage = z.infer<typeof adminUserPageSchema>;
export const adminUserDetailSchema = adminUserRowSchema.extend({
  role: z.enum(profileRoles),
  emailConfirmedAt: timestampSchema.nullable(),
  lastSignInAt: timestampSchema.nullable(),
  suspendedAt: timestampSchema.nullable(),
  suspendedReason: z.string().nullable(),
  /** F13 hard-delete date during the grace period. */
  deletionAt: timestampSchema.nullable(),
  /** Newest first: audit entries targeting this user (the drawer's "linha do tempo"). */
  timeline: z.array(auditEntrySchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

// --- maps (FR-15) -------------------------------------------------------------------------------
export const adminMapListQuerySchema = adminListQuerySchema.extend({
  origin: z.enum(adminMapOrigins).optional(),
  status: z.enum(adminMapStatuses).optional(),
});
export type AdminMapListQuery = z.input<typeof adminMapListQuerySchema>;
export const adminMapRowSchema = z.object({
  id: idSchema,
  title: z.string(),
  /** CCR-014: line under the title ("Clínica Médica"). */
  area: z.enum(areas),
  owner: adminUserRefSchema.nullable(),
  cards: count,
  edges: count,
  status: z.enum(adminMapStatuses),
  origin: z.enum(adminMapOrigins),
  createdAt: timestampSchema,
});
export type AdminMapRow = z.infer<typeof adminMapRowSchema>;
export const adminMapPageSchema = pageOf(adminMapRowSchema).extend({
  /** CCR-014 chips (mapas, privados, seeds em rascunho, seeds aprovados): maps matching `q`, ignoring origin/status. `total` includes archived. */
  summary: z.object({ total: count, private: count, seedDraft: count, seedApproved: count }),
});
export type AdminMapPage = z.infer<typeof adminMapPageSchema>;
/** POST /v1/admin/maps/:id/open → the board graph (read-only, "modo auditoria") + the audit entry. */
export const adminMapOpenResultSchema = adminActionResultSchema.extend({ graph: boardGraphSchema });
export type AdminMapOpenResult = z.infer<typeof adminMapOpenResultSchema>;

// --- payments (FR-16) ---------------------------------------------------------------------------
export const adminPaymentListQuerySchema = adminListQuerySchema.extend({
  status: z.enum(paymentStatuses).optional(),
  method: z.enum(paymentRecordMethods).optional(),
});
export type AdminPaymentListQuery = z.input<typeof adminPaymentListQuerySchema>;
export const paymentEventSchema = z.object({ type: z.enum(paymentEventTypes), at: timestampSchema });
export const adminPaymentRowSchema = z.object({
  /** Stripe id (D-428): PaymentIntent `pi_…`, or invoice `in_…` when there is no PaymentIntent (credit/100% coupon). */
  id: z.string(),
  user: adminUserRefSchema.nullable(),
  item: z.enum(paymentItems),
  method: z.enum(paymentRecordMethods),
  coupon: z.string().nullable(),
  status: z.enum(paymentStatuses),
  amountCents: cents,
  currency: z.string(),
  createdAt: timestampSchema,
});
export type AdminPaymentRow = z.infer<typeof adminPaymentRowSchema>;
export const adminPaymentPageSchema = pageOf(adminPaymentRowSchema).extend({
  summary: z.object({ receivedCents: cents, paid: count, pending: count, failed: count, refunded: count }),
});
export type AdminPaymentPage = z.infer<typeof adminPaymentPageSchema>;
export const adminPaymentDetailSchema = adminPaymentRowSchema.extend({
  stripeCustomerId: z.string().nullable(),
  stripeSubscriptionId: z.string().nullable(),
  stripePaymentIntent: z.string().nullable(),
  stripeInvoiceId: z.string().nullable(),
  refundedAt: timestampSchema.nullable(),
  timeline: z.array(paymentEventSchema),
  audit: z.array(auditEntrySchema),
});
export type AdminPaymentDetail = z.infer<typeof adminPaymentDetailSchema>;
/** "Marcar como pago": the admin confirms having checked Stripe or the bank (regras de negócio). */
export const markPaidInputSchema = reasonInputSchema.extend({ checked: z.literal(true) });
export type MarkPaidInput = z.input<typeof markPaidInputSchema>;

// --- referrals (FR-17) --------------------------------------------------------------------------
export const adminReferralListQuerySchema = adminListQuerySchema.extend({
  status: z.enum(adminReferralStatuses).optional(),
  channel: z.enum(referralChannels).optional(),
});
export type AdminReferralListQuery = z.input<typeof adminReferralListQuerySchema>;
export const adminReferralRowSchema = z.object({
  id: idSchema,
  referrer: adminUserRefSchema.nullable(),
  referee: adminUserRefSchema.nullable(),
  /** Invited by e-mail and not signed up yet. */
  invitedEmailMasked: z.string().nullable(),
  channel: z.enum(referralChannels),
  status: z.enum(adminReferralStatuses),
  fraudSignals: z.array(z.enum(referralRejectReasons)),
  /** Grants not revoked for this referral (0, 1 or 2). */
  rewardMonths: count,
  createdAt: timestampSchema,
});
export type AdminReferralRow = z.infer<typeof adminReferralRowSchema>;
export const adminReferralPageSchema = pageOf(adminReferralRowSchema).extend({
  summary: z.object({ qualified: count, inProgress: count, inReview: count, rejected: count, monthsGranted: count }),
});
export type AdminReferralPage = z.infer<typeof adminReferralPageSchema>;
export const adminReferralDetailSchema = adminReferralRowSchema.extend({
  signedUpAt: timestampSchema.nullable(),
  qualifiedAt: timestampSchema.nullable(),
  grants: z.array(z.object({ id: idSchema, userId: idSchema, startsAt: timestampSchema, endsAt: timestampSchema, revokedAt: timestampSchema.nullable() })),
  audit: z.array(auditEntrySchema),
});
export type AdminReferralDetail = z.infer<typeof adminReferralDetailSchema>;
export const revokeGrantInputSchema = reasonInputSchema.extend({ grantId: idSchema });
export type RevokeGrantInput = z.input<typeof revokeGrantInputSchema>;

// --- support inbox (FR-18) ----------------------------------------------------------------------
export const adminTicketListQuerySchema = adminListQuerySchema.extend({
  status: z.enum(supportTicketStatuses).optional(),
  type: z.enum(supportTicketTypes).optional(),
  assignedToMe: queryBool.optional(),
});
export type AdminTicketListQuery = z.input<typeof adminTicketListQuerySchema>;
export const adminTicketRowSchema = z.object({
  id: idSchema,
  number: z.number().int().positive(),
  user: adminUserRefSchema.nullable(),
  type: z.enum(supportTicketTypes),
  subject: z.string(),
  status: z.enum(supportTicketStatuses),
  assignedTo: adminUserRefSchema.nullable(),
  /** CCR-014: last non-internal message, whitespace collapsed, cut by the server to ≤ 140 chars (with "…"). */
  preview: z.string().max(ADMIN_LIMITS.ticketPreviewMax),
  lastUserMessageAt: timestampSchema,
  createdAt: timestampSchema,
});
export type AdminTicketRow = z.infer<typeof adminTicketRowSchema>;
export const adminTicketPageSchema = pageOf(adminTicketRowSchema).extend({
  /** Filter chips (Todos, Aberto, Em análise, Respondido, Resolvido), ignoring the status filter. */
  counts: z.object({ all: count, open: count, in_review: count, answered: count, resolved: count,
    /** CCR-014 header "N abertos · M sem responsável": not resolved and assigned_to null. */
    unassigned: count }),
});
export type AdminTicketPage = z.infer<typeof adminTicketPageSchema>;
export const adminTicketMessageSchema = z.object({
  id: idSchema,
  authorType: z.enum(supportAuthorTypes),
  author: adminUserRefSchema.nullable(),
  body: z.string(),
  internal: z.boolean(),
  attachments: z.array(supportAttachmentSchema),
  createdAt: timestampSchema,
});
export type AdminTicketMessage = z.infer<typeof adminTicketMessageSchema>;
/** The detail shows the whole thread, so no `preview`. */
export const adminTicketDetailSchema = adminTicketRowSchema.omit({ preview: true }).extend({
  plan: z.enum(plans),
  context: supportContextSchema.nullable(),
  messages: z.array(adminTicketMessageSchema),
});
export type AdminTicketDetail = z.infer<typeof adminTicketDetailSchema>;
/** Reply (e-mail + app) or internal note. Routine inbox actions take no typed reason (D-432). */
export const adminTicketReplyInputSchema = z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) });
export type AdminTicketReplyInput = z.input<typeof adminTicketReplyInputSchema>;

// --- waitlist (CCR-020, D-578) -------------------------------------------------------------------
/**
 * GET /v1/admin/waitlist: F16 sign-ups (`waitlist` table), newest first; `q` = e-mail contains (ILIKE). Behind requireAdmin
 * (404 for non-admin). Read-only and not sensitive (no reauth), but every call writes one `waitlist.view` audit row
 * (withAdmin, sensitive: false, reason ADMIN_AUTO_REASONS.waitlistView, target route '/v1/admin/waitlist'), counts in `after`.
 * CSV: POST /v1/admin/export with resource 'waitlist' (typed reason, `export.csv` row), same filters as this query.
 */
export const ADMIN_AUTO_REASONS = { waitlistView: 'consulta da lista de espera', storeWaitlistView: 'consulta da lista de espera da loja' } as const;
export const adminWaitlistListQuerySchema = adminListQuerySchema.extend({ segment: segmentSchema.optional() });
export type AdminWaitlistListQuery = z.input<typeof adminWaitlistListQuerySchema>;
export const adminWaitlistRowSchema = z.object({
  id: idSchema,
  email: z.string(),
  /** Stored as text (pre-validation rows may hold anything); null = not given. */
  segment: z.string().nullable(),
  /** Price variant from ?v= (e.g. '29'). */
  variant: z.string().nullable(),
  /** `waitlist.source` (the landing origin). */
  origin: z.string().nullable(),
  createdAt: timestampSchema,
});
export type AdminWaitlistRow = z.infer<typeof adminWaitlistRowSchema>;
export const adminWaitlistPageSchema = pageOf(adminWaitlistRowSchema);
export type AdminWaitlistPage = z.infer<typeof adminWaitlistPageSchema>;

// --- export (FR-13, FR-16, FR-19, FR-21) --------------------------------------------------------
/** POST /v1/admin/export → text/csv; audited; users/payments also e-mail an alert to the admin. */
export const adminExportInputSchema = reasonInputSchema.extend({
  resource: z.enum(adminExportResources),
  /** Same filters as the list route of that resource (validated by that schema on the server). */
  filters: z.record(z.string(), z.string()).default({}),
});
export type AdminExportInput = z.input<typeof adminExportInputSchema>;
