import { describe, expect, it } from 'vitest';
import { nextChargeDate } from '@remoa/contracts';
import { addPeriod, createMockStripe, discounted } from './stripe';

describe('addPeriod (Pix expiry) agrees with nextChargeDate at month ends (D-184/D-191)', () => {
  const day = (iso: string, p: 'monthly' | 'annual') => addPeriod(new Date(iso), p).toISOString().slice(0, 10);
  it.each([
    ['2026-01-31T12:00:00Z', 'monthly', '2026-02-28'],
    ['2028-01-31T12:00:00Z', 'monthly', '2028-02-29'],
    ['2026-03-31T12:00:00Z', 'monthly', '2026-04-30'],
    ['2026-12-31T12:00:00Z', 'monthly', '2027-01-31'],
    ['2028-02-29T12:00:00Z', 'annual', '2029-02-28'],
    ['2026-05-15T12:00:00Z', 'annual', '2027-05-15'],
  ] as const)('%s + %s = %s', (from, p, want) => {
    expect(day(from, p)).toBe(want);
    expect(nextChargeDate(p, new Date(from), 'UTC')).toBe(want);
  });
  it('keeps the time of day', () => expect(addPeriod(new Date('2026-01-31T15:04:05.678Z'), 'monthly').toISOString()).toBe('2026-02-28T15:04:05.678Z'));
});

describe('discounted', () => {
  it('percent rounds to the centavo, amount never goes below zero', () => {
    expect(discounted(3900, { percentOff: 25, amountOff: null })).toBe(2925);
    expect(discounted(34900, { percentOff: 25, amountOff: null })).toBe(26175);
    expect(discounted(3333, { percentOff: 33.5, amountOff: null })).toBe(2216);
    expect(discounted(3900, { percentOff: null, amountOff: 1000 })).toBe(2900);
    expect(discounted(500, { percentOff: null, amountOff: 1000 })).toBe(0);
    expect(discounted(3900, null)).toBe(3900);
  });
});

describe('mock Stripe (STRIPE=mock)', () => {
  const args = { userId: 'u1', customerId: 'cus_1', period: 'monthly' as const, method: 'pix' as const, amount: 3900, idempotencyKey: 'k1' };
  const idOf = (url: string) => new URL(url).searchParams.get('session')!;

  it('prices come from PRICES_BRL; FUNDADOR is the only code', async () => {
    const { port } = createMockStripe({ apiOrigin: 'http://api.test' });
    expect(await port.prices()).toEqual({ monthly: { amount: 3900 }, annual: { amount: 34900 } });
    expect(await port.promotion('FUNDADOR', null)).toMatchObject({ percentOff: 25 });
    expect(await port.promotion('OUTRO', null)).toBeNull();
  });

  it('same idempotency key = same session; pending Pix stays unpaid until confirmed, both one-shot', async () => {
    const m = createMockStripe({ apiOrigin: 'http://api.test' });
    const url = await m.port.checkout(args);
    expect(await m.port.checkout(args)).toBe(url);
    const id = idOf(url);
    expect((await m.port.session(id))?.status).toBe('open');
    expect(m.mockEvent('checkout', id, { pending: true })).toBe('pending');
    expect(await m.port.session(id)).toMatchObject({ status: 'complete', paymentStatus: 'unpaid', userId: 'u1' });
    expect(await m.port.lastPayment('cus_1')).toBeNull();
    expect(m.mockEvent('checkout', id)).toBeNull();
    expect(m.mockPixConfirm(id)?.type).toBe('checkout.session.async_payment_succeeded');
    expect(m.mockPixConfirm(id)).toBeNull();
    expect(await m.port.lastPayment('cus_1')).toEqual({ period: 'monthly', amount: 3900 });
  });

  it('card checkout creates a monthly subscription that can switch to annual', async () => {
    const m = createMockStripe({ apiOrigin: 'http://api.test' });
    const id = idOf(await m.port.checkout({ ...args, method: 'card', idempotencyKey: 'k2', promo: { discount: { coupon: 'c' }, percentOff: 25, amountOff: null } }));
    const e = m.mockEvent('checkout', id);
    const subId = String((e as { data: { object: Record<string, unknown> } }).data.object.subscription);
    expect(await m.port.plan(subId)).toMatchObject({ period: 'monthly', amount: 2925 });
    const r = await m.port.switchAnnual({ customerId: 'cus_1', subscriptionId: subId, itemId: 'si', idempotencyKey: 'x' });
    expect(r).toMatchObject({ kind: 'switched', amount: 34900 });
    expect((await m.port.plan(subId)).period).toBe('annual');
  });
});
