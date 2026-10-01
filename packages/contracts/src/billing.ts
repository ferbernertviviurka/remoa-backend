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
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const billingPeriods = ['monthly', 'annual'] as const;
export const paymentMethods = ['pix', 'card'] as const;
export const checkoutInputSchema = z.object({
  period: z.enum(billingPeriods),
  method: z.enum(paymentMethods),
  coupon: z.string().optional(),
});
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export const redirectUrlSchema = z.object({ url: z.string().url() });
export type RedirectUrl = z.infer<typeof redirectUrlSchema>;
