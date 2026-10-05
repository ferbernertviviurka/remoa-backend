// G16 / F22 Fase A: store waitlist ("Em breve"). CCR-030, D-650–D-659. Distinct from the landing `waitlist` (onboarding.ts).
import { z } from 'zod';
import { timestampSchema } from './common';

/** `soon` is the only value implemented in Fase A (FR-14); `beta`/`open` are Fase B. */
export const storeStatuses = ['soon', 'beta', 'open'] as const;
export const storeStatusSchema = z.enum(storeStatuses);
export type StoreStatus = z.infer<typeof storeStatusSchema>;

/** GET /v1/store/config (any signed-in user). The split % is configuration (D-623), shown only as an illustrative example. */
export const storeConfigSchema = z.object({
  status: storeStatusSchema,
  /** Seller's share of an illustrative sale, whole percent 1–99. Server env STORE_SPLIT_SELLER_PCT (default 85). */
  splitSellerPct: z.number().int().min(1).max(99),
});
export type StoreConfig = z.infer<typeof storeConfigSchema>;

/** FR-8 / D-624: professor, aluno ou residente, médico formado (verified by CRM only in Fase B). */
export const storeSellerRoles = ['teacher', 'student_resident', 'physician'] as const;
export const storeSellerRoleSchema = z.enum(storeSellerRoles);
export type StoreSellerRole = z.infer<typeof storeSellerRoleSchema>;

/**
 * PUT /v1/store/waitlist: full replacement (upsert by user). At least one interest; `sellerRole` required when
 * interest has `sell`, and must be null when not. `consent` must be literally true (FR-9, LGPD): single
 * purpose = notify about the store.
 */
export const storeInterests = ['buy', 'sell'] as const;
export const storeWaitlistInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    /** At least one; duplicates collapse. */
    interest: z.array(z.enum(storeInterests)).min(1).max(2).transform((a) => [...new Set(a)]),
    sellerRole: storeSellerRoleSchema.nullable().default(null),
    consent: z.literal(true),
  })
  .superRefine((v, ctx) => {
    const sell = v.interest.includes('sell');
    if (sell && !v.sellerRole) ctx.addIssue({ code: 'custom', path: ['sellerRole'], message: 'sellerRole required when interest includes sell' });
    if (!sell && v.sellerRole) ctx.addIssue({ code: 'custom', path: ['sellerRole'], message: 'sellerRole only with sell' });
  });
export type StoreWaitlistInput = z.input<typeof storeWaitlistInputSchema>;

/** GET/PUT /v1/store/waitlist data (GET returns `null` when not on the list). DELETE returns `null`. */
export const storeWaitlistEntrySchema = z.object({
  email: z.string(),
  interest: z.array(z.enum(storeInterests)).min(1),
  sellerRole: storeSellerRoleSchema.nullable(),
  updatedAt: timestampSchema,
});
export type StoreWaitlistEntry = z.infer<typeof storeWaitlistEntrySchema>;

/**
 * GET /v1/admin/store-waitlist (requireAdmin, 404 for non-admin): counts only, no e-mails. Each call writes one
 * `store_waitlist.view` audit row (withAdmin, sensitive: false, ADMIN_AUTO_REASONS.storeWaitlistView, target route).
 * `buy`/`sell` count everyone who ticked it, so `both` is included in each; `total` = rows. `byRole` counts sellers only.
 * CSV (e-mails, so reason + `export.csv` audit): POST /v1/admin/export `{ resource: 'store_waitlist', reason, filters? }`,
 * filters `interest` (`buy` | `sell`) and `role` (a seller role), both optional.
 */
export const adminStoreWaitlistSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  buy: z.number().int().nonnegative(),
  sell: z.number().int().nonnegative(),
  both: z.number().int().nonnegative(),
  byRole: z.object({ teacher: z.number().int().nonnegative(), student_resident: z.number().int().nonnegative(), physician: z.number().int().nonnegative() }),
});
export type AdminStoreWaitlistSummary = z.infer<typeof adminStoreWaitlistSummarySchema>;
export const adminStoreWaitlistExportFiltersSchema = z.object({
  interest: z.enum(['buy', 'sell']).optional(),
  role: storeSellerRoleSchema.optional(),
});

export const storeErrors = { rateLimited: 'too many changes, try again later' } as const;
