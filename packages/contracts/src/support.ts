// F19 Suporte (CCR-011, D-425–D-434). Enum arrays are the single source for zod here and pgEnum in @remoa/db.
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { plans } from './enums';

/** UI chips (FR-3): Algo não funciona · Cobrança e plano · Conteúdo médico · Sugestão · Outro. */
export const supportTicketTypes = ['bug', 'billing', 'content', 'suggestion', 'other'] as const;
/** UI: Aberto · Em análise · Respondido · Resolvido (FR-7). */
export const supportTicketStatuses = ['open', 'in_review', 'answered', 'resolved'] as const;
export const supportAuthorTypes = ['user', 'admin', 'system'] as const;
/** FR-5: PNG or JPEG only (checked again by file signature on the server). */
export const supportAttachmentMimes = ['image/png', 'image/jpeg'] as const;

export type SupportTicketType = (typeof supportTicketTypes)[number];
export type SupportTicketStatus = (typeof supportTicketStatuses)[number];
export type SupportAuthorType = (typeof supportAuthorTypes)[number];

export const SUPPORT_LIMITS = {
  subjectMin: 5,
  subjectMax: 120,
  descriptionMin: 20,
  descriptionMax: 2000,
  attachmentsMax: 3,
  attachmentMaxBytes: 5 * 1024 * 1024,
  ticketsPerHour: 5,
  ticketsPerDay: 20,
  /** FR-6: same subject + description again within this window = duplicate. */
  duplicateWindowMinutes: 10,
  /** FR-7: a resolved ticket can be reopened (by replying) for this many days. */
  reopenDays: 14,
  /** FR-8: badge polling interval. */
  unreadPollSeconds: 60,
} as const;

/** `AppError.message` values for this lane (the generic ErrorCode in parentheses). */
export const supportErrors = {
  /** rate_limited — 5 per hour / 20 per day */
  rateLimited: 'support_rate_limited',
  /** conflict — same ticket twice within 10 min */
  duplicate: 'support_duplicate',
  /** conflict — resolved more than 14 days ago */
  closed: 'support_ticket_closed',
  /** validation — key not ours, not uploaded, or the bytes are not a PNG/JPEG */
  badAttachment: 'support_bad_attachment',
} as const;

// --- technical context (FR-4) ---------------------------------------------------
/**
 * The exact list the toggle describes and the server stores. `.strict()`: anything else (map content, tokens,
 * billing data) fails validation instead of being silently dropped. `screen` is a pathname only (no query or hash,
 * which could carry share tokens).
 */
export const supportContextSchema = z
  .object({
    screen: z.string().max(200).regex(/^\/[A-Za-z0-9/_\-[\]]*$/),
    plan: z.enum(plans),
    browser: z.string().trim().max(80),
    os: z.string().trim().max(80),
    appVersion: z.string().trim().max(40),
    timezone: z.string().trim().max(64),
  })
  .strict();
export type SupportContext = z.infer<typeof supportContextSchema>;

// --- attachments (FR-5) ---------------------------------------------------------------
/** POST /v1/support/attachments/sign → UploadSignOutput (presigned PUT; key = `support/<userId>/<uuid>`). */
export const supportAttachmentSignInputSchema = z.object({
  mime: z.enum(supportAttachmentMimes),
  sizeBytes: z.number().int().positive().max(SUPPORT_LIMITS.attachmentMaxBytes),
});
export type SupportAttachmentSignInput = z.infer<typeof supportAttachmentSignInputSchema>;
/** The key returned by sign; the server re-checks ownership, signature and size, and strips EXIF, on submit. */
const attachmentKeysSchema = z
  .array(z.string().min(1).max(300))
  .max(SUPPORT_LIMITS.attachmentsMax)
  .refine((a) => new Set(a).size === a.length, 'duplicate_attachment')
  .default([]);

export const supportAttachmentSchema = z.object({
  id: idSchema,
  mime: z.enum(supportAttachmentMimes),
  sizeBytes: z.number().int().positive(),
  /** Short-lived signed GET (owner or admin only). */
  url: z.string().url(),
});
export type SupportAttachment = z.infer<typeof supportAttachmentSchema>;

// --- inputs ---------------------------------------------------------------------------
/** POST /v1/support/tickets (FR-3). `context: null` = toggle off (nothing technical is stored). The reply e-mail is the account's. */
export const supportTicketInputSchema = z.object({
  type: z.enum(supportTicketTypes),
  subject: z.string().trim().min(SUPPORT_LIMITS.subjectMin).max(SUPPORT_LIMITS.subjectMax),
  description: z.string().trim().min(SUPPORT_LIMITS.descriptionMin).max(SUPPORT_LIMITS.descriptionMax),
  attachments: attachmentKeysSchema,
  context: supportContextSchema.nullable(),
});
export type SupportTicketInput = z.input<typeof supportTicketInputSchema>;

/** POST /v1/support/tickets/:id/messages — replying reopens (answered/resolved → open; resolved only within reopenDays). */
export const supportReplyInputSchema = z.object({
  body: z.string().trim().min(1).max(SUPPORT_LIMITS.descriptionMax),
  attachments: attachmentKeysSchema,
});
export type SupportReplyInput = z.input<typeof supportReplyInputSchema>;

// --- views (user) ---------------------------------------------------------------------
/** "#1042" = `#${number}`. */
export const formatTicketNumber = (n: number) => `#${n}`;

export const supportTicketSummarySchema = z.object({
  id: idSchema,
  number: z.number().int().positive(),
  type: z.enum(supportTicketTypes),
  subject: z.string(),
  status: z.enum(supportTicketStatuses),
  /** last_admin_reply_at > last_user_read_at (orange dot, FR-7). */
  unread: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SupportTicketSummary = z.infer<typeof supportTicketSummarySchema>;

/** User-visible message. Internal notes never reach this shape. Admin author shows as the team (no admin id). */
export const supportMessageSchema = z.object({
  id: idSchema,
  authorType: z.enum(supportAuthorTypes),
  body: z.string(),
  attachments: z.array(supportAttachmentSchema),
  createdAt: timestampSchema,
});
export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const supportTicketDetailSchema = supportTicketSummarySchema.extend({
  messages: z.array(supportMessageSchema),
  context: supportContextSchema.nullable(),
  /** Resolved tickets: last day a reply still reopens; null otherwise. */
  reopenableUntil: timestampSchema.nullable(),
});
export type SupportTicketDetail = z.infer<typeof supportTicketDetailSchema>;

/** POST /v1/support/tickets → "Chamado #1042 enviado." */
export const supportTicketCreatedSchema = z.object({ id: idSchema, number: z.number().int().positive() });
export type SupportTicketCreated = z.infer<typeof supportTicketCreatedSchema>;

/** GET /v1/support/unread — badge on the button and the "Meus chamados" tab. */
export const supportUnreadSchema = z.object({ count: z.number().int().nonnegative() });
export type SupportUnread = z.infer<typeof supportUnreadSchema>;
