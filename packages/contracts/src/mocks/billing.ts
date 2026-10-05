// F15 mocks for the frontend: PriceBook from PRICES_BRL (D-182), FUNDADOR coupon, checkout sessions and subscriptions.
import { ok, err } from '../errors';
import {
  FOUNDER_PRICE_CENTS,
  PRICES_BRL,
  couponInputSchema,
  nextChargeDate,
  type CheckoutSessionStatus,
  type CouponValidation,
  type PriceBook,
  type SubscriptionSummary,
} from '../billing';
import type * as Api from '../api';
import { FIXTURE_NOW } from './fixtures';

const DAY = 86_400_000;
const at = (days: number) => new Date(FIXTURE_NOW.getTime() + days * DAY);
const TZ = 'America/Sao_Paulo';

export const priceBookFixture: PriceBook = {
  monthly: { amount: PRICES_BRL.monthly * 100, currency: 'brl', priceId: 'price_mock_monthly' },
  annual: { amount: PRICES_BRL.annual * 100, currency: 'brl', priceId: 'price_mock_annual' },
  lifetime: { amount: FOUNDER_PRICE_CENTS, currency: 'brl', priceId: 'price_mock_lifetime' },
  nextChargeOn: { monthly: nextChargeDate('monthly', FIXTURE_NOW, TZ), annual: nextChargeDate('annual', FIXTURE_NOW, TZ) },
  fetchedAt: FIXTURE_NOW,
};

/** Q-024: R$ 29/mês and R$ 249/ano are example values only. */
export const couponFundadorFixture: CouponValidation = { valid: true, kind: 'amount', monthly: 2900, annual: 24900 };
export const couponInvalidFixture: CouponValidation = { valid: false };

export const checkoutSessionFixtures = {
  cs_mock_paid: { status: 'paid', plan: 'pro', period: 'annual', method: 'card' },
  cs_mock_pending_pix: { status: 'pending_pix', plan: 'pro', period: 'monthly', method: 'pix' },
  cs_mock_canceled: { status: 'canceled', plan: 'pro', period: 'monthly', method: 'card' },
  cs_mock_founder_paid: { status: 'paid', plan: 'founder', period: 'lifetime', method: 'card' },
} satisfies Record<string, CheckoutSessionStatus>;

const monthlyActive: SubscriptionSummary = {
  status: 'active', period: 'monthly', method: 'card', amount: PRICES_BRL.monthly * 100,
  renewsAt: at(18), cancelAtPeriodEnd: false, graceUntil: null, pastDue: false,
};
export const subscriptionFixtures = {
  monthlyActive,
  pastDue: { ...monthlyActive, status: 'past_due', renewsAt: at(-2), graceUntil: at(5), pastDue: true },
  cancelScheduled: { ...monthlyActive, cancelAtPeriodEnd: true },
  founder: { status: 'active', period: 'lifetime', method: 'pix', amount: FOUNDER_PRICE_CENTS, renewsAt: null, cancelAtPeriodEnd: false, graceUntil: null, pastDue: false },
} satisfies Record<string, SubscriptionSummary>;

export const getPriceBook: Api.GetPriceBook = async () => ok(priceBookFixture);
export const validateCoupon: Api.ValidateCoupon = async (_userId, input) => {
  const p = couponInputSchema.safeParse(input);
  return ok(p.success && p.data.code === 'FUNDADOR' ? couponFundadorFixture : couponInvalidFixture);
};
export const getCheckoutSession: Api.GetCheckoutSession = async (_userId, sessionId) => {
  const s = (checkoutSessionFixtures as Record<string, CheckoutSessionStatus>)[sessionId];
  return s ? ok(s) : err('not_found', 'checkout session not found');
};
export const getSubscription: Api.GetSubscription = async () => ok(subscriptionFixtures.monthlyActive);
export const switchToAnnual: Api.SwitchToAnnual = async () => ok({ kind: 'switched', renewsAt: at(365), amount: PRICES_BRL.annual * 100 });
