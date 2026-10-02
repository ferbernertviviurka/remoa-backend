import { describe, expect, it } from 'vitest';
import {
  PLAN_LIMITS,
  annualDiscountPercent,
  annualSavings,
  checkoutInputSchema,
  checkoutSessionIdSchema,
  couponInputSchema,
  couponValidationSchema,
  formatBRL,
  monthlyEquivalent,
  nextChargeDate,
  planDefinition,
  planFeatureKeys,
  priceBookSchema,
  subscriptionSummarySchema,
  switchToAnnualResultSchema,
  checkoutSessionStatusSchema,
  type Entitlements,
} from './billing';
import { comparisonRows } from './account';
import { eventSchemas } from './events';
import * as m from './mocks';

const book = (monthly: number, annual: number) => ({ monthly: { amount: monthly }, annual: { amount: annual } });
const nb = (s: string) => s.replace(/\s/g, ' ');

describe('F15 price math', () => {
  it.each([
    [3900, 34900, 25, 11900, 2908],
    [3900, 46800, 0, 0, 3900],
    [1000, 6000, 50, 6000, 500],
    [3900, 50000, 0, 0, 4167], // annual dearer: never a negative discount
    [0, 34900, 0, 0, 2908],
  ])('monthly %i annual %i → %i%% off, saves %i, %i/mês', (mo, an, pct, save, eq) => {
    expect(annualDiscountPercent(book(mo, an))).toBe(pct);
    expect(annualSavings(book(mo, an))).toBe(save);
    expect(monthlyEquivalent(book(mo, an))).toBe(eq);
  });

  it.each([
    [3900, 'R$ 39,00'],
    [34900, 'R$ 349,00'],
    [2908, 'R$ 29,08'],
    [0, 'R$ 0,00'],
    [123456, 'R$ 1.234,56'],
  ])('formatBRL(%i) = %s', (c, s) => expect(nb(formatBRL(c))).toBe(s));

  it.each([
    ['monthly', '2026-10-02T12:00:00Z', 'America/Sao_Paulo', '2026-11-02'],
    ['annual', '2026-10-02T12:00:00Z', 'America/Sao_Paulo', '2027-10-02'],
    ['monthly', '2026-12-15T12:00:00Z', 'America/Sao_Paulo', '2027-01-15'],
    ['monthly', '2027-01-31T12:00:00Z', 'America/Sao_Paulo', '2027-02-28'],
    ['monthly', '2028-01-31T12:00:00Z', 'America/Sao_Paulo', '2028-02-29'],
    ['annual', '2028-02-29T12:00:00Z', 'America/Sao_Paulo', '2029-02-28'],
    // 01:00 UTC on Nov 1 is still Oct 31 in São Paulo → Nov 30
    ['monthly', '2026-11-01T01:00:00Z', 'America/Sao_Paulo', '2026-11-30'],
    ['monthly', '2026-11-01T01:00:00Z', 'UTC', '2026-12-01'],
  ] as const)('nextChargeDate(%s, %s, %s) = %s', (period, from, tz, out) => expect(nextChargeDate(period, new Date(from), tz)).toBe(out));
});

describe('F15 plan definition and matrix', () => {
  it('derives from PLAN_LIMITS', () => {
    expect(planDefinition('free')).toEqual({
      ...PLAN_LIMITS.free.limits,
      anki_import_cards: PLAN_LIMITS.free.ankiImportMaxCards,
      new_cards_per_day: PLAN_LIMITS.free.newCardsPerDay,
    });
    expect(planDefinition('pro').boards).toBeNull();
  });

  const free: Pick<Entitlements, 'usage' | 'limits'> = {
    limits: PLAN_LIMITS.free.limits,
    usage: { boards: 2, cards: Math.ceil(PLAN_LIMITS.free.limits.cards * 0.8), ai_grades: 0, ai_generations: 0 },
  };

  it('puts usage and tone on metered rows, in FR-4 order', () => {
    const rows = comparisonRows(free);
    expect(rows.map((r) => r.key)).toEqual([...planFeatureKeys]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.boards!.usage).toEqual({ used: 2, limit: PLAN_LIMITS.free.limits.boards, tone: 'full' });
    expect(by.cards!.usage!.tone).toBe('warn');
    expect(by.ai_grades!.usage!.tone).toBe('normal');
    expect(by.anki_import_cards!.usage).toBeNull();
    expect(by.new_cards_per_day!.usage).toBeNull();
    expect(by.boards!.pro).toBeNull();
  });

  it('Pro usage is never warned on unlimited rows; null entitlements = no usage', () => {
    const pro = comparisonRows({ limits: PLAN_LIMITS.pro.limits, usage: { boards: 99, cards: 9999, ai_grades: 500, ai_generations: 20 } });
    expect(pro.find((r) => r.key === 'boards')!.usage!.tone).toBe('normal');
    expect(pro.find((r) => r.key === 'ai_generations')!.usage!.tone).toBe('full');
    expect(comparisonRows(null).every((r) => r.usage === null)).toBe(true);
  });
});

describe('F15 schemas', () => {
  it('normalizes coupon codes and rejects junk', () => {
    expect(couponInputSchema.parse({ code: '  fundador ' }).code).toBe('FUNDADOR');
    expect(couponInputSchema.safeParse({ code: '' }).success).toBe(false);
    expect(couponInputSchema.safeParse({ code: 'a b' }).success).toBe(false);
    expect(couponInputSchema.safeParse({ code: 'x'.repeat(41) }).success).toBe(false);
  });

  it('invalid coupon carries no reason', () => {
    expect(couponValidationSchema.safeParse({ valid: false, reason: 'expired' }).success).toBe(false);
    expect(couponValidationSchema.parse({ valid: true, kind: 'percent', monthly: 2900, annual: 24900 }).valid).toBe(true);
  });

  it('checkout accepts the F08 coupon and the F15 couponCode', () => {
    expect(checkoutInputSchema.parse({ period: 'monthly', method: 'pix', coupon: 'FUNDADOR' }).coupon).toBe('FUNDADOR');
    expect(checkoutInputSchema.parse({ period: 'annual', method: 'card', couponCode: 'fundador' }).couponCode).toBe('FUNDADOR');
    expect(checkoutInputSchema.safeParse({ period: 'annual', method: 'card', couponCode: '' }).success).toBe(false);
  });

  it('session ids', () => {
    expect(checkoutSessionIdSchema.safeParse('cs_test_a1B2').success).toBe(true);
    expect(checkoutSessionIdSchema.safeParse('cs_mock_0f').success).toBe(true);
    expect(checkoutSessionIdSchema.safeParse('../etc').success).toBe(false);
  });

  it('mocks satisfy the schemas', async () => {
    priceBookSchema.parse(m.priceBookFixture);
    expect(m.priceBookFixture.monthly.amount).toBe(3900);
    expect(annualDiscountPercent(m.priceBookFixture)).toBe(25);
    for (const s of Object.values(m.checkoutSessionFixtures)) checkoutSessionStatusSchema.parse(s);
    for (const s of Object.values(m.subscriptionFixtures)) subscriptionSummarySchema.parse(s);
    const data = <T>(r: { ok: true; data: T } | { ok: false }) => (r.ok ? r.data : null);
    expect(data(await m.validateCoupon('u', { code: 'fundador' }))).toEqual(m.couponFundadorFixture);
    expect(data(await m.validateCoupon('u', { code: 'NOPE' }))).toEqual({ valid: false });
    expect(data(await m.validateCoupon('u', { code: '' }))).toEqual({ valid: false });
    expect(data(await m.getCheckoutSession('u', 'cs_mock_pending_pix'))?.status).toBe('pending_pix');
    expect((await m.getCheckoutSession('u', 'cs_other')).ok).toBe(false);
    subscriptionSummarySchema.parse(data(await m.getSubscription('u')));
    priceBookSchema.parse(data(await m.getPriceBook('u', new Date())));
    switchToAnnualResultSchema.parse(data(await m.switchToAnnual('u')));
  });

  it('F15 events never accept the coupon code', () => {
    expect(eventSchemas.coupon_failed.safeParse({ code: 'FUNDADOR' }).success).toBe(false);
    expect(eventSchemas.checkout_started.safeParse({ period: 'annual', method: 'pix', coupon: true }).success).toBe(true);
    expect(eventSchemas.checkout_started.safeParse({ period: 'annual', method: 'pix' }).success).toBe(true);
    expect(eventSchemas.plans_viewed.safeParse({ from: 'boards' }).success).toBe(true);
    expect(eventSchemas.plans_viewed.safeParse({ from: 'evil' }).success).toBe(false);
  });
});
