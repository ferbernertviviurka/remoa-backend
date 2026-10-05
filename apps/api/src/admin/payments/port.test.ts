// F19 T4: payments port resolution is fail-closed (mock only in development/test) and the mock refund is idempotent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockPayments, paymentsPort, setPaymentsPort } from './port';

describe('paymentsPort', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setPaymentsPort(undefined);
  });

  it('STRIPE=mock outside development/test resolves to nothing; no secret = nothing; override wins', () => {
    vi.stubEnv('STRIPE', 'mock');
    vi.stubEnv('NODE_ENV', 'production');
    expect(paymentsPort()).toBeNull();
    vi.stubEnv('NODE_ENV', 'test');
    expect(paymentsPort()).not.toBeNull();
    vi.stubEnv('STRIPE', '');
    vi.stubEnv('STRIPE_SECRET', '');
    setPaymentsPort(null);
    expect(paymentsPort()).toBeNull();
  });

  it('mock: same idempotency key refunds once; receipt URL per payment; invoices have no PaymentIntent', async () => {
    const m = createMockPayments();
    await m.refund({ paymentIntent: 'pi_1', idempotencyKey: 'refund:pi_1', amountCents: 100 });
    await m.refund({ paymentIntent: 'pi_1', idempotencyKey: 'refund:pi_1', amountCents: 100 });
    expect(await m.receiptUrl({ paymentIntent: null, invoiceId: 'in_1' })).toContain('in_1');
    expect(await m.invoicePayment('in_1')).toBeNull();
  });
});
