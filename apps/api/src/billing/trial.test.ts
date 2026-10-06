// D-1213/D-1214 integration: the free Pro trial granted by the sign-up trigger (0039). Needs TEST_DATABASE_URL; skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRIAL_DAYS, type Entitlements, type ReferralSummary } from '@remoa/contracts';
import { emailHash } from '../referral/email-normalize';
import type { StripePort } from './stripe';

config({ path: '../../.env' });

const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('D-1213 free Pro trial', () => {
  const users: string[] = [];
  const hashes: string[] = [];
  let dbm: typeof import('@remoa/db');
  let ent: typeof import('./entitlements');
  let g: typeof import('./grants');
  let wh: typeof import('./webhook');
  let summary: typeof import('../referral/summary');
  let fake: StripePort;

  const signUp = async (email = `${uuid()}@test.local`) => {
    const id = uuid();
    users.push(id);
    hashes.push(emailHash(email));
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role) values (${id}, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    return id;
  };
  const trials = (u: string) => dbm.db.select().from(dbm.entitlementGrants).where(eq(dbm.entitlementGrants.userId, u));
  const plan = async (u: string, now = new Date()) => ((await ent.getEntitlements(u, now)) as { ok: true; data: Entitlements }).data;
  const referral = async (referrerId: string) => {
    const [r] = await dbm.db.insert(dbm.referrals).values({ referrerId, refereeId: await signUp(), channel: 'link', status: 'signed_up', signedUpAt: new Date() }).returning();
    return r!.id;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    ent = await import('./entitlements');
    g = await import('./grants');
    wh = await import('./webhook');
    summary = await import('../referral/summary');
    const mock = (await import('./stripe')).createMockStripe({ apiOrigin: 'http://api.test' });
    fake = { ...mock.port, subscription: async () => ({ status: 'active', renewsAt: new Date(Date.now() + 30 * DAY), cancelAtPeriodEnd: false }) };
  });
  afterAll(async () => {
    if (!dbm) return;
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`);
    if (hashes.length) await dbm.db.execute(sql`delete from trial_claims where email_hash in (${sql.join(hashes.map((h) => sql`${h}`), sql`, `)})`);
  });

  it('the SQL hash is the D-386 emailHash byte for byte', async () => {
    const tag = uuid().slice(0, 8);
    for (const e of [` Jo.Ao+${tag}@GoogleMail.com `, `maria.silva+x@gmail.com`, `Pedro.Souza+estudo@usp.br`, `a@b.com`]) {
      const [r] = await dbm.db.execute<{ h: string }>(sql`select public.remoa_email_hash(${e}) as h`);
      expect(r!.h).toBe(emailHash(e));
    }
  });

  it('sign-up gives TRIAL_DAYS of Pro once: plan pro, trialUntil = grantUntil = end, no subscription', async () => {
    const before = Date.now();
    const u = await signUp();
    const rows = await trials(u);
    expect(rows).toHaveLength(1);
    const t = rows[0]!;
    expect(t).toMatchObject({ source: 'trial', plan: 'pro', revokedAt: null, referralId: null });
    expect(t.startsAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(t.endsAt.getTime() - t.startsAt.getTime()).toBe(TRIAL_DAYS * DAY);
    const e = await plan(u);
    expect(e).toMatchObject({ plan: 'pro', status: null, trialUntil: t.endsAt, grantUntil: t.endsAt });
    expect(e.limits.boards).toBeNull();
  });

  it('ends on its own: after ends_at the account is Free and trialUntil is null; the row is kept', async () => {
    const u = await signUp();
    const [t] = await trials(u);
    const e = await plan(u, new Date(t!.endsAt.getTime() + 1_000));
    expect(e).toMatchObject({ plan: 'free', trialUntil: null, grantUntil: null });
    expect(await trials(u)).toHaveLength(1);
  });

  it('one per e-mail: the same normalized address after the account was deleted gets no second trial', async () => {
    const tag = uuid().slice(0, 8);
    const first = await signUp(`Ana.${tag}+estudo@gmail.com`);
    expect(await trials(first)).toHaveLength(1);
    await dbm.db.execute(sql`delete from auth.users where id = ${first}`);
    const again = await signUp(`ana${tag}+outro@GoogleMail.com`); // same address once normalized
    expect(await trials(again)).toHaveLength(0);
    expect((await plan(again)).plan).toBe('free');
  });

  it('one per account: a second trial row for the same user is refused by the unique index', async () => {
    const u = await signUp();
    await expect(dbm.db.insert(dbm.entitlementGrants).values({ userId: u, source: 'trial', startsAt: new Date(), endsAt: new Date(Date.now() + DAY) })).rejects.toThrow();
  });

  it('a referral month during the trial queues after it; trialUntil = trial end, grantUntil = chain end; then the month runs', async () => {
    const u = await signUp();
    const [t] = await trials(u);
    const ref = await referral(u);
    const m = await dbm.db.transaction((tx) => g.grantReferralMonth(tx, { userId: u, referralId: ref, stripe: fake }));
    if (m.kind !== 'month') throw new Error('expected a month');
    expect(m.grant.startsAt).toEqual(t!.endsAt);
    expect(await plan(u)).toMatchObject({ plan: 'pro', trialUntil: t!.endsAt, grantUntil: m.grant.endsAt });
    expect(await plan(u, new Date(t!.endsAt.getTime() + DAY))).toMatchObject({ plan: 'pro', trialUntil: null, grantUntil: m.grant.endsAt });
  });

  it('referral summary: the trial alone shows no "Pro grátis até"; with a referral month the whole chain shows', async () => {
    const u = await signUp();
    const s1 = ((await summary.getReferralSummary(u)) as { ok: true; data: ReferralSummary }).data;
    expect(s1.proUntil).toBeNull();
    const ref = await referral(u);
    const m = await dbm.db.transaction((tx) => g.grantReferralMonth(tx, { userId: u, referralId: ref, stripe: fake }));
    if (m.kind !== 'month') throw new Error('expected a month');
    const s2 = ((await summary.getReferralSummary(u)) as { ok: true; data: ReferralSummary }).data;
    expect(s2.proUntil && new Date(s2.proUntil)).toEqual(m.grant.endsAt);
  });

  it('Pix bought during the trial starts now, not when the trial ends (D-1214)', async () => {
    const u = await signUp();
    const before = new Date();
    const evt = { id: `evt_${uuid()}`, type: 'checkout.session.completed', data: { object: { mode: 'payment', payment_status: 'paid', client_reference_id: u, customer: 'cus_pix', subscription: null, metadata: { userId: u, period: 'monthly' } } } };
    expect(await wh.applyStripeEvent(evt, fake)).toBe('applied');
    const [s] = await dbm.db.select().from(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u));
    const month = new Date(before);
    month.setUTCMonth(month.getUTCMonth() + 1);
    expect(Math.abs(s!.renewsAt!.getTime() - month.getTime())).toBeLessThan(60_000);
    expect(await plan(u)).toMatchObject({ plan: 'pro', status: 'active', trialUntil: null, grantUntil: null });
  });

  it('card subscription during the trial: the paid plan rules, the trial is not shown', async () => {
    const u = await signUp();
    await dbm.db.insert(dbm.subscriptions).values({ userId: u, plan: 'pro', status: 'active', stripeCustomerId: `cus_${uuid()}`, stripeSubscriptionId: `sub_${uuid()}`, renewsAt: new Date(Date.now() + 30 * DAY) });
    expect(await plan(u)).toMatchObject({ plan: 'pro', status: 'active', trialUntil: null, grantUntil: null });
  });
});
