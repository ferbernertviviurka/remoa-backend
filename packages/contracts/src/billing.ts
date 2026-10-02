import { z } from 'zod';
import { plans, subscriptionStatuses } from './enums';
import { idSchema, timestampSchema } from './common';

export const planSchema = z.enum(plans);

/** Metered quotas = columns of `usage_counters`. */
export const quotaKeys = ['ai_grades', 'ai_generations', 'boards', 'cards'] as const;
export const quotaKeySchema = z.enum(quotaKeys);
export type QuotaKey = z.infer<typeof quotaKeySchema>;

export const paywallReasons = ['ai_quota', 'boards', 'cards', 'pdf'] as const;
export type PaywallReason = (typeof paywallReasons)[number];

export const usageCountersSchema = z.object({
  userId: idSchema,
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  aiGrades: z.number().int().nonnegative(),
  aiGenerations: z.number().int().nonnegative(),
  boards: z.number().int().nonnegative(),
  cards: z.number().int().nonnegative(),
});
export type UsageCounters = z.infer<typeof usageCountersSchema>;

const quotaRecord = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ ai_grades: v, ai_generations: v, boards: v, cards: v });

/** Computed on the server; the client only displays it. `null` limit = unlimited. */
export const entitlementsSchema = z.object({
  plan: planSchema,
  status: z.enum(subscriptionStatuses).nullable(), // null = never subscribed
  limits: quotaRecord(z.number().int().nonnegative().nullable()),
  usage: quotaRecord(z.number().int().nonnegative()),
  newCardsPerDay: z.number().int().positive(),
  ankiImportMaxCards: z.number().int().positive(),
  renewsAt: timestampSchema.nullable(),
  /** F08: canceled in the portal, Pro until renewsAt. */
  cancelAtPeriodEnd: z.boolean(),
  /** F08 FR-6: payment failed; Pro kept until this instant (renewsAt + PRO_GRACE_DAYS). */
  graceUntil: timestampSchema.nullable(),
});

/**
 * F08 plan table (provisional, Q-002), shared by server (enforcement) and pricing page (display).
 * Windows: ai_grades per local study day; ai_generations per calendar month; boards/cards = live totals.
 */
export const PLAN_LIMITS = {
  free: { limits: { ai_grades: 20, ai_generations: 1, boards: 3, cards: 200 }, newCardsPerDay: 10, ankiImportMaxCards: 5000 },
  pro: { limits: { ai_grades: null, ai_generations: 20, boards: null, cards: null }, newCardsPerDay: 20, ankiImportMaxCards: 20000 },
} as const satisfies Record<z.infer<typeof planSchema>, Pick<Entitlements, 'limits' | 'newCardsPerDay' | 'ankiImportMaxCards'>>;
export const PRO_GRACE_DAYS = 7;
export const PRICES_BRL = { monthly: 39, annual: 349 } as const;
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const billingPeriods = ['monthly', 'annual'] as const;
export const paymentMethods = ['pix', 'card'] as const;
export const checkoutInputSchema = z.object({
  period: z.enum(billingPeriods),
  method: z.enum(paymentMethods),
  coupon: z.string().optional(),
});
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export const portalInputSchema = z.object({ cancel: z.boolean().optional() }); // cancel: open the portal on the cancel flow
export type PortalInput = z.infer<typeof portalInputSchema>;

/** F08 FR-7 (LGPD): everything the user owns, as returned by POST /v1/account/export. */
const rows = z.array(z.record(z.string(), z.unknown()));
export const accountExportSchema = z.object({
  version: z.literal(1),
  exportedAt: timestampSchema,
  userId: idSchema,
  profile: z.record(z.string(), z.unknown()).nullable(),
  boards: rows,
  cards: rows,
  edges: rows,
  attempts: rows,
});
export type AccountExport = z.infer<typeof accountExportSchema>;

export const redirectUrlSchema = z.object({ url: z.string().url() });
export type RedirectUrl = z.infer<typeof redirectUrlSchema>;
