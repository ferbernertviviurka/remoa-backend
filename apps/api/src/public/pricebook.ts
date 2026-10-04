// F16 FR-12: public price book (no user); schema lives in @remoa/contracts (D-234).
import { err, ok, publicPriceBookSchema, type PublicPriceBook, type Result } from '@remoa/contracts';
import { cachedPrices } from '../billing/checkout';
import { plansPort, type StripePort } from '../billing/stripe';

export { publicPriceBookSchema, type PublicPriceBook };

const TTL = 10 * 60_000;
const cache = new WeakMap<object, { at: number; p: Promise<{ monthly: number; annual: number; lifetime: number }> }>();

export const getPublicPriceBook = (stripe?: StripePort) => async (variant?: '29' | '49'): Promise<Result<PublicPriceBook>> => {
  const plans = plansPort(stripe);
  if (!plans) return err('internal', 'billing unavailable');
  let hit = cache.get(plans);
  if (!hit || Date.now() - hit.at > TTL) {
    const p = cachedPrices(plans).then((b) => ({ monthly: b.monthly.amount, annual: b.annual.amount, lifetime: b.lifetime.amount }));
    p.catch(() => cache.delete(plans));
    cache.set(plans, (hit = { at: Date.now(), p }));
  }
  const base = await hit.p;
  const founder = process.env.BETA_FOUNDER === '1';
  const lifetime = { amount: base.lifetime }; // D-375: the price test only moves Pro
  if (!variant) return ok({ monthly: { amount: base.monthly }, annual: { amount: base.annual }, lifetime, currency: 'brl', founder });
  const monthly = Number(variant) * 100;
  const annual = Math.round((base.annual * monthly) / base.monthly / 100) * 100; // whole reais
  return ok({ monthly: { amount: monthly }, annual: { amount: annual }, lifetime, currency: 'brl', founder, variant });
};
