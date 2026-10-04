// F19 T4 (D-456): the Stripe calls of the payments lane. Kept out of billing/stripe.ts (F08/F15 shared file) and resolved
// from the environment, because routes/admin.ts gets no StripePort. Mock is fail-closed: only with NODE_ENV=development|test.
import Stripe from 'stripe';
import { createLogger } from '@remoa/log';
import { installedStripe } from '../../billing/stripe';

export type PaymentsPort = {
  /** PaymentIntent of the invoice's latest payment; null = settled without one (customer balance, 100% coupon). */
  invoicePayment: (invoiceId: string) => Promise<string | null>;
  /** Full refund. Same idempotency key = the same refund at Stripe (a retry never refunds twice). */
  refund: (a: { paymentIntent: string; idempotencyKey: string; amountCents: number }) => Promise<void>;
  /** charge.receipt_url, else the invoice's hosted URL. */
  receiptUrl: (a: { paymentIntent: string | null; invoiceId: string | null }) => Promise<string | null>;
};

const devLike = () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

export const createPaymentsStripe = (secret: string): PaymentsPort => {
  const s = new Stripe(secret);
  const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));
  return {
    invoicePayment: async (invoice) => idOf((await s.invoicePayments.list({ invoice, limit: 1 })).data[0]?.payment.payment_intent),
    refund: async ({ paymentIntent, idempotencyKey }) => void (await s.refunds.create({ payment_intent: paymentIntent }, { idempotencyKey })),
    receiptUrl: async ({ paymentIntent, invoiceId }) => {
      if (paymentIntent) {
        const charge = (await s.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] })).latest_charge;
        if (charge && typeof charge !== 'string' && charge.receipt_url) return charge.receipt_url;
      }
      return invoiceId ? ((await s.invoices.retrieve(invoiceId)).hosted_invoice_url ?? null) : null;
    },
  };
};

/** Dev/e2e fake: a refund is confirmed by the same `charge.refunded` handler the real webhook uses (like the F08 mock checkout). */
export const createMockPayments = (): PaymentsPort => {
  const refunds = new Set<string>();
  return {
    invoicePayment: async () => null,
    refund: async ({ paymentIntent, idempotencyKey, amountCents }) => {
      if (refunds.has(idempotencyKey)) return;
      refunds.add(idempotencyKey);
      const stripe = installedStripe();
      if (!stripe) return;
      const event = { id: `evt_mock_refund_${paymentIntent}`, type: 'charge.refunded', data: { object: { payment_intent: paymentIntent, refunded: true, amount_refunded: amountCents } } };
      // After the admin transaction commits (it holds the payment row lock).
      setTimeout(() => void import('../../billing/webhook').then((m) => m.applyStripeEvent(event, stripe)).catch((e: unknown) =>
        createLogger({ requestId: event.id }).error('mock refund webhook failed', { error: String(e) })), 50);
    },
    receiptUrl: async ({ paymentIntent, invoiceId }) => `https://stripe.test/receipt/${paymentIntent ?? invoiceId}`,
  };
};

let override: PaymentsPort | null | undefined;
let cached: PaymentsPort | undefined;
/** Tests only. `undefined` restores the environment lookup. */
export const setPaymentsPort = (p: PaymentsPort | null | undefined) => void (override = p);

/** null = Stripe not configured (actions answer 500; the webhook mirror keys invoices by `in_…`). */
export function paymentsPort(): PaymentsPort | null {
  if (override !== undefined) return override;
  if (process.env.STRIPE === 'mock') return devLike() ? (cached ??= createMockPayments()) : null;
  return process.env.STRIPE_SECRET ? (cached ??= createPaymentsStripe(process.env.STRIPE_SECRET)) : null;
}
