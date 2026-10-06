// F18 T4 integration (D-381, D-408–D-411): needs local Supabase; skipped otherwise. Stripe is faked at the port.
import { config } from 'dotenv';
import { dropTrial } from '../test-trial';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entitlements } from '@remoa/contracts';
import type { PlansPort, StripePort } from './stripe';

config({ path: '../../.env' });

const DAY = 86_400_000;
const plusMonth = (d: Date) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + 1);
  return x;
};

describe.skipIf(!process.env.DATABASE_URL)('F18 grants + credits', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let g: typeof import('./grants');
  let cr: typeof import('./credits');
  let ent: typeof import('./entitlements');
  let wh: typeof import('./webhook');
  let mock: ReturnType<typeof import('./stripe').createMockStripe>;

  // Card subscriptions known to the fake: id → plan detail. `failBalance` makes createBalanceTransaction throw.
  const plans = new Map<string, { period: 'monthly' | 'annual'; amount: number }>();
  let failBalance = false;
  const keys: string[] = [];
  let fake: StripePort & PlansPort;

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dropTrial(id);
    return id;
  };
  /** A referral row whose referrer is `referrerId` (a fresh referee each time). */
  const referral = async (referrerId: string) => {
    const [r] = await dbm.db.insert(dbm.referrals).values({ referrerId, refereeId: await newUser(), channel: 'link', status: 'signed_up', signedUpAt: new Date() }).returning();
    return r!.id;
  };
  const grant = (userId: string, referralId: string, now = new Date(), stripe: StripePort | undefined = fake) =>
    dbm.db.transaction((tx) => g.grantReferralMonth(tx, { userId, referralId, now, stripe }));
  const plan = async (u: string, now = new Date()) => ((await ent.getEntitlements(u, now)) as { ok: true; data: Entitlements }).data;
  const card = async (userId: string, period: 'monthly' | 'annual', amount: number, extra: Partial<typeof dbm.subscriptions.$inferInsert> = {}) => {
    const subId = `sub_${uuid()}`;
    plans.set(subId, { period, amount });
    await dbm.db.insert(dbm.subscriptions).values({ userId, plan: 'pro', status: 'active', stripeCustomerId: `cus_${uuid()}`, stripeSubscriptionId: subId, renewsAt: new Date(Date.now() + 20 * DAY), ...extra });
    return subId;
  };
  const credits = (u: string) => dbm.db.select().from(dbm.billingCredits).where(eq(dbm.billingCredits.userId, u));
  const grants = (u: string) => dbm.db.select().from(dbm.entitlementGrants).where(eq(dbm.entitlementGrants.userId, u)).orderBy(dbm.entitlementGrants.startsAt);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    g = await import('./grants');
    cr = await import('./credits');
    ent = await import('./entitlements');
    wh = await import('./webhook');
    mock = (await import('./stripe')).createMockStripe({ apiOrigin: 'http://api.test' });
    fake = {
      ...mock.port,
      subscription: async () => ({ status: 'active', renewsAt: new Date(Date.now() + 30 * DAY), cancelAtPeriodEnd: false }),
      plan: async (id) => {
        const p = plans.get(id);
        if (!p) throw new Error('stripe down');
        return { ...p, itemId: 'si_1' };
      },
      createBalanceTransaction: async (a) => {
        keys.push(a.idempotencyKey);
        if (failBalance) throw new Error('stripe timeout');
        return mock.port.createBalanceTransaction!(a);
      },
    };
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((i) => `'${i}'`).join(',')})`));
  });

  it('chains: the second month starts when the first ends; Pro with grantUntil = end of the chain', async () => {
    const u = await newUser();
    const now = new Date('2026-01-31T12:00:00Z');
    const a = await grant(u, await referral(u), now);
    const b = await grant(u, await referral(u), new Date(now.getTime() + 5 * DAY)); // granted while the first is running
    expect(a.kind).toBe('month');
    expect(b.kind).toBe('month');
    if (a.kind !== 'month' || b.kind !== 'month') return;
    expect(a.grant.startsAt).toEqual(now);
    expect(a.grant.endsAt.toISOString()).toBe('2026-02-28T12:00:00.000Z'); // calendar month, clamped like Postgres
    expect(b.grant.startsAt).toEqual(a.grant.endsAt);
    expect(b.grant.endsAt.toISOString()).toBe('2026-03-28T12:00:00.000Z');
    const e = await plan(u, new Date(now.getTime() + DAY));
    expect(e).toMatchObject({ plan: 'pro', status: null, grantUntil: b.grant.endsAt });
    expect(e.limits.boards).toBeNull();
  });

  it('a grant after the chain ended starts now, not at the old end', async () => {
    const u = await newUser();
    const t0 = new Date('2026-01-01T00:00:00Z');
    await grant(u, await referral(u), t0);
    const later = new Date('2026-05-10T00:00:00Z');
    const r = await grant(u, await referral(u), later);
    expect(r.kind === 'month' && r.grant.startsAt).toEqual(later);
  });

  it('idempotent per (referral, user): re-running returns the same row, no duplicate', async () => {
    const u = await newUser();
    const ref = await referral(u);
    const a = await grant(u, ref);
    const b = await grant(u, ref);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.kind === 'month' && a.kind === 'month' && b.grant.id).toBe(a.kind === 'month' && a.grant.id);
    expect(await grants(u)).toHaveLength(1);
  });

  it('concurrent grants for one user serialize on the advisory lock: contiguous chain, no overlap', async () => {
    const u = await newUser();
    const refs = await Promise.all([referral(u), referral(u), referral(u)]);
    const now = new Date();
    await Promise.all([...refs, refs[0]!].map((r) => grant(u, r, now)));
    const rows = await grants(u);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.startsAt).toEqual(now);
    expect(rows[1]!.startsAt).toEqual(rows[0]!.endsAt);
    expect(rows[2]!.startsAt).toEqual(rows[1]!.endsAt);
  });

  it('getEntitlements: active → Pro; expired → Free and rows kept; revoked → Free; not started yet → Free', async () => {
    const u = await newUser();
    const now = new Date('2026-03-01T00:00:00Z');
    const r = await grant(u, await referral(u), now);
    if (r.kind !== 'month') throw new Error('expected a month');
    expect((await plan(u, new Date('2026-03-15T00:00:00Z'))).plan).toBe('pro');
    const after = await plan(u, r.grant.endsAt); // ends_at is exclusive
    expect(after).toMatchObject({ plan: 'free', grantUntil: null });
    expect(after.limits.boards).toBe(2);
    expect(await grants(u)).toHaveLength(1); // FR-22: nothing deleted
    expect((await plan(u, new Date('2026-02-28T00:00:00Z'))).plan).toBe('free'); // before starts_at

    await dbm.db.update(dbm.entitlementGrants).set({ revokedAt: new Date(), revokedReason: 'fraud' }).where(eq(dbm.entitlementGrants.id, r.grant.id));
    expect((await plan(u, new Date('2026-03-15T00:00:00Z'))).plan).toBe('free');
    // a revoked grant does not hold the chain: the next one starts now
    const n = await grant(u, await referral(u), new Date('2026-03-15T00:00:00Z'));
    expect(n.kind === 'month' && n.grant.startsAt.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('monthly subscriber: the month becomes a credit of the monthly price (what they pay)', async () => {
    const u = await newUser();
    await card(u, 'monthly', 3900);
    const r = await grant(u, await referral(u));
    expect(r).toMatchObject({ kind: 'credit', created: true, credit: { amountCents: 3900, currency: 'brl', appliedAt: null, stripeBalanceTxnId: null } });
    expect(await grants(u)).toHaveLength(0);
    expect((await plan(u)).grantUntil).toBeNull();
  });

  it('annual subscriber: 1/12 of the annual price, rounded to the centavo; re-run is idempotent', async () => {
    const u = await newUser();
    await card(u, 'annual', 34900);
    const ref = await referral(u);
    const r = await grant(u, ref);
    expect(r.kind === 'credit' && r.credit.amountCents).toBe(2908);
    expect(await grant(u, ref)).toMatchObject({ kind: 'credit', created: false });
    expect(await credits(u)).toHaveLength(1);
  });

  it('subscriber paying 0 (100% coupon): no credit possible, grant chained after the paid period', async () => {
    const u = await newUser();
    const renews = new Date(Date.now() + 15 * DAY);
    await card(u, 'monthly', 0, { renewsAt: renews });
    const r = await grant(u, await referral(u));
    expect(r.kind === 'month' && r.grant.startsAt).toEqual(renews);
  });

  it('Stripe down while pricing a credit: throws so the caller rolls back (sweep retries)', async () => {
    const u = await newUser();
    await dbm.db.insert(dbm.subscriptions).values({ userId: u, plan: 'pro', status: 'active', stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_unknown', renewsAt: new Date(Date.now() + 9 * DAY) });
    const ref = await referral(u);
    await expect(grant(u, ref)).rejects.toThrow('stripe down');
    await expect(grant(u, ref, new Date(), { ...fake, plan: undefined })).rejects.toThrow('billing unavailable');
    expect(await credits(u)).toHaveLength(0);
  });

  it('paid but not renewing (Pix, cancel scheduled): grant chained after the paid period', async () => {
    const pix = await newUser();
    const renews = new Date(Date.now() + 10 * DAY);
    await dbm.db.insert(dbm.subscriptions).values({ userId: pix, plan: 'pro', status: 'active', stripeCustomerId: 'cus_p', renewsAt: renews, cancelAtPeriodEnd: true });
    const r = await grant(pix, await referral(pix));
    expect(r.kind === 'month' && r.grant.startsAt).toEqual(renews);
    expect((await plan(pix, new Date(renews.getTime() + DAY)))).toMatchObject({ plan: 'pro', grantUntil: r.kind === 'month' ? r.grant.endsAt : null });

    const canceling = await newUser();
    await card(canceling, 'monthly', 3900, { cancelAtPeriodEnd: true, renewsAt: renews });
    const c = await grant(canceling, await referral(canceling));
    expect(c.kind === 'month' && c.grant.startsAt).toEqual(renews);
  });

  it('applyPendingCredits: Stripe failure leaves it pending; retry applies once with the same idempotency key', async () => {
    const u = await newUser();
    await card(u, 'monthly', 3900);
    const r = await grant(u, await referral(u));
    if (r.kind !== 'credit') throw new Error('expected credit');
    const stripeCustomerId = (await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u)))[0]!.stripeCustomerId!;

    failBalance = true;
    expect(await cr.applyPendingCredits(u, fake)).toEqual({ applied: 0, pending: 1 });
    expect((await credits(u))[0]).toMatchObject({ appliedAt: null, stripeBalanceTxnId: null });
    failBalance = false;

    expect(await cr.applyPendingCredits(u, fake)).toEqual({ applied: 1, pending: 0 });
    const [row] = await credits(u);
    expect(row!.appliedAt).not.toBeNull();
    expect(row!.stripeBalanceTxnId).toMatch(/^cbtxn_mock_/);
    expect(mock.mockBalance(stripeCustomerId)).toBe(-3900);
    expect(await cr.applyPendingCredits(u, fake)).toEqual({ applied: 0, pending: 0 });
    expect(keys.filter((k) => k === `referral-credit:${r.credit.id}`)).toHaveLength(2); // the failed try + the good one
    // same key replayed at Stripe = same transaction, balance unchanged
    expect(await fake.createBalanceTransaction!({ customerId: stripeCustomerId, amountCents: 3900, idempotencyKey: `referral-credit:${r.credit.id}`, description: 'x' })).toBe(row!.stripeBalanceTxnId);
    expect(mock.mockBalance(stripeCustomerId)).toBe(-3900);
  });

  it('applyPendingCredits never pushes the credit of a referral later rejected (manual review/fraud)', async () => {
    const u = await newUser();
    await card(u, 'monthly', 3900);
    const ref = await referral(u);
    const r = await grant(u, ref);
    if (r.kind !== 'credit') throw new Error('expected credit');
    await dbm.db.execute(sql`update referrals set status = 'rejected', reject_reason = 'manual' where id = ${ref}`);
    const before = keys.length;
    expect((await cr.applyPendingCredits(u, fake)).applied).toBe(0);
    expect((await cr.applyPendingCredits(undefined, fake)).applied).toBeGreaterThanOrEqual(0);
    expect(keys.slice(before)).not.toContain(`referral-credit:${r.credit.id}`);
    expect((await credits(u))[0]).toMatchObject({ appliedAt: null });
  });

  it('applyPendingCredits without a port or customer keeps rows pending; sweep form (no user) picks them up', async () => {
    const u = await newUser();
    await card(u, 'monthly', 3900);
    await grant(u, await referral(u));
    expect(await cr.applyPendingCredits(u, undefined)).toEqual({ applied: 0, pending: 1 });
    await dbm.db.update(dbm.subscriptions).set({ stripeCustomerId: null }).where(eq(dbm.subscriptions.userId, u));
    expect((await cr.applyPendingCredits(u, fake)).applied).toBe(0);
    await dbm.db.update(dbm.subscriptions).set({ stripeCustomerId: 'cus_sweep' }).where(eq(dbm.subscriptions.userId, u));
    expect((await cr.applyPendingCredits(undefined, fake)).applied).toBeGreaterThanOrEqual(1);
    expect((await credits(u))[0]!.appliedAt).not.toBeNull();
  });

  it('card subscription bought during free months: grants left are revoked and become credit (running one prorated)', async () => {
    const u = await newUser();
    const started = new Date(Date.now() - 10 * DAY);
    const done = await grant(u, await referral(u), new Date(started.getTime() - 120 * DAY)); // already over: untouched
    const a = await grant(u, await referral(u), started);
    const b = await grant(u, await referral(u), started);
    if (a.kind !== 'month' || b.kind !== 'month' || done.kind !== 'month') throw new Error('expected months');
    const subId = `sub_${uuid()}`;
    plans.set(subId, { period: 'monthly', amount: 3900 });
    const before = Date.now();
    const evt = { id: `evt_${uuid()}`, type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: u, customer: `cus_${uuid()}`, subscription: subId, metadata: { userId: u, period: 'monthly' } } } };
    expect(await wh.applyStripeEvent(evt, fake)).toBe('applied');
    const after = Date.now();

    const rows = await grants(u);
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(a.grant.id)).toMatchObject({ revokedReason: 'converted' });
    expect(byId.get(b.grant.id)).toMatchObject({ revokedReason: 'converted' });
    expect(byId.get(done.grant.id)!.revokedAt).toBeNull();
    const cs = await credits(u);
    expect(cs).toHaveLength(2);
    const full = cs.find((x) => x.referralId === b.grant.referralId)!;
    const part = cs.find((x) => x.referralId === a.grant.referralId)!;
    expect(full.amountCents).toBe(3900);
    const span = a.grant.endsAt.getTime() - a.grant.startsAt.getTime();
    const left = (t: number) => Math.round((3900 * (a.grant.endsAt.getTime() - t)) / span);
    expect(part.amountCents).toBeGreaterThanOrEqual(left(after));
    expect(part.amountCents).toBeLessThanOrEqual(left(before));
    // pushed to Stripe after commit
    expect(cs.every((x) => x.appliedAt && x.stripeBalanceTxnId)).toBe(true);
    // Pro now comes from the subscription; replaying the event changes nothing
    expect(await plan(u)).toMatchObject({ plan: 'pro', grantUntil: null });
    expect(await wh.applyStripeEvent(evt, fake)).toBe('duplicate');
    expect(await credits(u)).toHaveLength(2);
    // and a later referral month for this subscriber is a credit, not a grant
    expect((await grant(u, await referral(u))).kind).toBe('credit');
  });

  it('card subscription converts only referral grants; a support grant stays and is not credited', async () => {
    const u = await newUser();
    const r = await grant(u, await referral(u), new Date(Date.now() - 2 * DAY));
    if (r.kind !== 'month') throw new Error('expected month');
    const [sup] = await dbm.db.insert(dbm.entitlementGrants).values({ userId: u, source: 'support', startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 10 * DAY) }).returning();
    const subId = `sub_${uuid()}`;
    plans.set(subId, { period: 'monthly', amount: 3900 });
    const evt = { id: `evt_${uuid()}`, type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid', client_reference_id: u, customer: `cus_${uuid()}`, subscription: subId, metadata: { userId: u, period: 'monthly' } } } };
    expect(await wh.applyStripeEvent(evt, fake)).toBe('applied');
    const byId = new Map((await grants(u)).map((x) => [x.id, x]));
    expect(byId.get(r.grant.id)).toMatchObject({ revokedReason: 'converted' });
    expect(byId.get(sup!.id)!.revokedAt).toBeNull();
    expect(await credits(u)).toHaveLength(1);
  });

  it('Pix bought during free months starts when the grants end (months kept as time)', async () => {
    const u = await newUser();
    const r = await grant(u, await referral(u), new Date(Date.now() - 2 * DAY));
    if (r.kind !== 'month') throw new Error('expected month');
    const evt = { id: `evt_${uuid()}`, type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', client_reference_id: u, customer: 'cus_pix', subscription: null, metadata: { userId: u, period: 'monthly' } } } };
    expect(await wh.applyStripeEvent(evt, fake)).toBe('applied');
    const [s] = await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u));
    expect(s!.renewsAt).toEqual(plusMonth(r.grant.endsAt));
    const [kept] = await dbm.db.select().from(dbm.entitlementGrants).where(and(eq(dbm.entitlementGrants.userId, u)));
    expect(kept!.revokedAt).toBeNull();
    expect(await credits(u)).toHaveLength(0);
  });
});
