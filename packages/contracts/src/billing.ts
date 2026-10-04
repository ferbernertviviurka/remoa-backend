import { z } from 'zod';
import { plans, subscriptionStatuses } from './enums';
import { idSchema, timestampSchema } from './common';
import { supportAuthorTypes } from './support';

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
  /** F18 (D-381): Pro comes from referral grants (no paying subscription); end of the grant chain. Absent/null otherwise. */
  grantUntil: timestampSchema.nullable().optional(),
});

/**
 * F08 plan table (provisional, Q-002), shared by server (enforcement) and pricing page (display).
 * Windows: ai_grades per local study day; ai_generations per calendar month; boards/cards = live totals.
 */
export const PLAN_LIMITS = {
  free: { limits: { ai_grades: 20, ai_generations: 1, boards: 2, cards: 50 }, newCardsPerDay: 10, ankiImportMaxCards: 5000 },
  pro: { limits: { ai_grades: null, ai_generations: 20, boards: null, cards: null }, newCardsPerDay: 20, ankiImportMaxCards: 20000 },
  /** D-375: lifetime one-time purchase = Pro + unlimited AI. Never renews, never lapses. */
  founder: { limits: { ai_grades: null, ai_generations: null, boards: null, cards: null }, newCardsPerDay: 20, ankiImportMaxCards: 20000 },
} as const satisfies Record<z.infer<typeof planSchema>, Pick<Entitlements, 'limits' | 'newCardsPerDay' | 'ankiImportMaxCards'>>;
export const PRO_GRACE_DAYS = 7;
export const PRICES_BRL = { monthly: 39, annual: 349 } as const;
/** D-375: Founder (lifetime) fallback/mock price in centavos; the real one comes from STRIPE_PRICE_LIFETIME. */
export const FOUNDER_PRICE_CENTS = 59990;
export type Entitlements = z.infer<typeof entitlementsSchema>;

/** `lifetime` = Founder one-time purchase (D-375): Stripe payment mode, no subscription, no coupon. */
export const billingPeriods = ['monthly', 'annual', 'lifetime'] as const;
export const paymentMethods = ['pix', 'card'] as const;
export const checkoutInputSchema = z.object({
  period: z.enum(billingPeriods),
  method: z.enum(paymentMethods),
  /** F08 alias of `couponCode`; the server reads `couponCode ?? coupon` (D-185). */
  coupon: z.string().optional(),
  /** F15: promotion code, validated on the server (FUNDADOR today). */
  couponCode: z.lazy(() => couponCodeSchema).optional(),
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
  /** F19 FR-9 (D-443, D-471): the user's tickets with only user-visible messages; no `assignedTo`, no internal notes. */
  tickets: z.array(
    z.object({ id: idSchema, number: z.number().int(), messages: z.array(z.object({ id: idSchema, authorType: z.enum(supportAuthorTypes), body: z.string(), createdAt: timestampSchema }).strict()) })
      .catchall(z.unknown())
      .refine((t) => !('assignedTo' in t), 'assignedTo is staff data'),
  ),
});
export type AccountExport = z.infer<typeof accountExportSchema>;

export const redirectUrlSchema = z.object({ url: z.string().url() });
export type RedirectUrl = z.infer<typeof redirectUrlSchema>;

// --- F15 planos e checkout (D-183–D-187) ------------------------------------
/** F15 FR-4 matrix rows, in display order. Values derive from PLAN_LIMITS (still the single source). */
export const planFeatureKeys = ['boards', 'cards', 'ai_grades', 'ai_generations', 'anki_import_cards', 'new_cards_per_day'] as const;
export type PlanFeatureKey = (typeof planFeatureKeys)[number];
/** null = unlimited. ai_grades = correções por IA/dia; ai_generations = mapas de PDF/mês; anki_import_cards = cards por arquivo (F06). */
export type PlanDefinition = Record<PlanFeatureKey, number | null>;
export const planDefinition = (plan: z.infer<typeof planSchema>): PlanDefinition => {
  const p = PLAN_LIMITS[plan];
  return { ...p.limits, anki_import_cards: p.ankiImportMaxCards, new_cards_per_day: p.newCardsPerDay };
};

const cents = z.number().int().nonnegative();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type BillingPeriod = (typeof billingPeriods)[number];
/** Periods that renew (have a next charge). */
export type RecurringPeriod = Exclude<BillingPeriod, 'lifetime'>;
export type PaymentMethod = (typeof paymentMethods)[number];

/** Stripe `Price` (cached), in centavos. `priceId` absent with STRIPE=mock or for the Pix one-time price_data. */
const priceSchema = z.object({ amount: cents, currency: z.literal('brl'), priceId: z.string().min(1).optional() });
export const priceBookSchema = z.object({
  monthly: priceSchema,
  annual: priceSchema,
  /** D-375: Founder, one-time. */
  lifetime: priceSchema,
  /** FR-6 "Próxima cobrança em": computed by the server in the user's timezone (nextChargeDate). */
  nextChargeOn: z.object({ monthly: isoDate, annual: isoDate }),
  fetchedAt: timestampSchema,
});
export type PriceBook = z.infer<typeof priceBookSchema>;

/** F16 (D-233/D-234): GET /v1/public/pricebook, no user. Amounts in centavos; `variant` only with ?v=29|49 (waitlist price test). */
export const publicPriceBookSchema = z.object({
  monthly: z.object({ amount: z.number().int() }),
  annual: z.object({ amount: z.number().int() }),
  /** D-375: Founder, one-time. */
  lifetime: z.object({ amount: z.number().int() }),
  currency: z.literal('brl'),
  founder: z.boolean(),
  variant: z.enum(['29', '49']).optional(),
});
export type PublicPriceBook = z.infer<typeof publicPriceBookSchema>;
type Amounts = { monthly: { amount: number }; annual: { amount: number } };

/** FR-2: round((1 − annual ÷ (monthly × 12)) × 100); 0 when there is nothing to compare. */
export const annualDiscountPercent = ({ monthly, annual }: Amounts) =>
  monthly.amount > 0 ? Math.max(0, Math.round((1 - annual.amount / (monthly.amount * 12)) * 100)) : 0;
/** FR-5 "Economize R$ X por ano", in centavos. */
export const annualSavings = ({ monthly, annual }: Amounts) => Math.max(0, monthly.amount * 12 - annual.amount);
/** FR-5 annual shown per month, in centavos (rounded). */
export const monthlyEquivalent = ({ annual }: Amounts) => Math.round(annual.amount / 12);

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** Centavos → "R$ 39,00" (Intl uses a no-break space after R$). */
export const formatBRL = (amountCents: number) => brl.format(amountCents / 100);

const pad = (n: number) => String(n).padStart(2, '0');
/** Next charge as a local date (YYYY-MM-DD in `tz`); day clamps to the month's end (Jan 31 → Feb 28/29), like Stripe. */
export function nextChargeDate(period: RecurringPeriod, from: Date, tz: string): string {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(from)
    .split('-')
    .map(Number) as [number, number, number];
  const idx = m - 1 + (period === 'annual' ? 12 : 1);
  const ty = y + Math.floor(idx / 12);
  const tm = idx % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

// coupon
/** Stripe promotion codes are case-insensitive: trimmed and upper-cased. */
export const couponCodeSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase());
export const couponInputSchema = z.object({ code: couponCodeSchema });
export type CouponInput = z.input<typeof couponInputSchema>;
/** Valid: prices after the code, in centavos. Invalid never says why (unknown, expired and used look the same). */
export const couponValidationSchema = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(true), kind: z.enum(['percent', 'amount']), monthly: cents, annual: cents }),
  z.object({ valid: z.literal(false) }).strict(),
]);
export type CouponValidation = z.infer<typeof couponValidationSchema>;

// checkout
export const checkoutResultSchema = redirectUrlSchema;
export type CheckoutResult = RedirectUrl;
/** Stripe checkout session id (`cs_…`; the mock uses `cs_mock_…`). */
export const checkoutSessionIdSchema = z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/);
export const checkoutOutcomes = ['paid', 'pending_pix', 'canceled', 'expired'] as const;
/** FR-8, verified on the server. `period: 'lifetime'` comes with `plan: 'founder'` (D-375). `paid` does not mean entitled: Pro comes from the webhook (D-181), so poll entitlements. */
export const checkoutSessionStatusSchema = z.object({
  status: z.enum(checkoutOutcomes),
  plan: planSchema,
  period: z.enum(billingPeriods),
  method: z.enum(paymentMethods),
});
export type CheckoutSessionStatus = z.infer<typeof checkoutSessionStatusSchema>;

// subscription (named Summary: `SubscriptionStatus` is already the status enum type in enums.ts)
/** FR-9. Status/dates are the Entitlements fields; adds what the matrix needs from Stripe. Founder: `period: 'lifetime'`, `renewsAt: null` (D-375). */
export const subscriptionSummarySchema = entitlementsSchema.pick({ status: true, renewsAt: true, cancelAtPeriodEnd: true, graceUntil: true }).extend({
  period: z.enum(billingPeriods),
  method: z.enum(paymentMethods),
  /** Amount of the current period, centavos, after any coupon. */
  amount: cents,
  /** status === 'past_due' (F08 FR-6). */
  pastDue: z.boolean(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;

/** Card: subscription updated with Stripe proration. Pix (no Stripe subscription) or SCA needed: redirect (checkout/portal). */
export const switchToAnnualResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switched'), renewsAt: timestampSchema, amount: cents }),
  z.object({ kind: z.literal('redirect'), url: z.string().url() }),
]);
export type SwitchToAnnualResult = z.infer<typeof switchToAnnualResultSchema>;
