// Integration (F18 T3): needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referralSummarySchema, inviteResultSchema } from '@remoa/contracts';

config({ path: '../../.env' });
process.env.UNSUBSCRIBE_SECRET ||= 'test-secret-test-secret';
type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!process.env.DATABASE_URL)('F18 /v1/referral summary + invites', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let admin: ReturnType<typeof import('../account/auth-admin').adminClient>;
  let mailer: typeof import('../account/mailer');
  let notify: typeof import('../referral/notify');

  const newUser = async (name: string | null = null, tz?: string) => {
    const { data, error } = await admin.auth.admin.createUser({ email: `f18-${uuid()}@test.local`, password: 'senha1234', email_confirm: true });
    if (error) throw error;
    const id = data.user.id;
    users.push(id);
    await dbm.db.update(dbm.profiles).set({ name, ...(tz ? { timezone: tz } : {}) }).where(eq(dbm.profiles.userId, id));
    return { id, email: data.user.email! };
  };
  const call = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/referral${path}`, { method, headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const sentTo = (to: string) => mailer.sentEmails().filter((m) => m.to === to);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    admin = (await import('../account/auth-admin')).adminClient();
    mailer = await import('../account/mailer');
    notify = await import('../referral/notify');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });

  it('summary: empty, lazy stable code, link', async () => {
    const u = await newUser('Ana Lima');
    const a = await call(u.id, 'GET', '/summary');
    expect(a.status).toBe(200);
    const s = referralSummarySchema.parse(a.json.data);
    expect(s).toMatchObject({ monthsEarned: 0, proUntil: null, proDaysTotal: 0, credit: 0, recentRewards: [], friends: [], invitesLeftToday: 20 });
    expect(s.link).toBe(`${process.env.WEB_ORIGIN ?? 'http://localhost:3000'}/i/${s.code}`);
    const b = await call(u.id, 'GET', '/summary');
    expect(b.json.data.code).toBe(s.code);
    const [n] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from referral_codes where user_id = ${u.id}`);
    expect(n!.n).toBe(1);
  });

  it('summary: in progress and Pro (grants, friend names, credit)', async () => {
    const ref = await newUser('Beatriz Souza Lima');
    const fr = await newUser('Daniel Souza');
    const [r] = await dbm.db.insert(dbm.referrals).values({ referrerId: ref.id, refereeId: fr.id, channel: 'link', status: 'qualified', signedUpAt: new Date(), qualifiedAt: new Date() }).returning();
    const inv = await call(ref.id, 'POST', '/invites', { emails: ['Zeca@Exemplo.com'] });
    expect(inv.status).toBe(200);
    let s = referralSummarySchema.parse((await call(ref.id, 'GET', '/summary')).json.data);
    expect(s.friends.map((f) => [f.displayName, f.status])).toEqual(expect.arrayContaining([['Daniel S.', 'qualified'], ['z***@exemplo.com', 'invited']]));
    expect(s.monthsEarned).toBe(0);
    const now = Date.now();
    await dbm.db.insert(dbm.entitlementGrants).values([
      { userId: ref.id, source: 'referral', referralId: r!.id, startsAt: new Date(now - 10 * 86_400_000), endsAt: new Date(now + 20 * 86_400_000) },
    ]);
    s = referralSummarySchema.parse((await call(ref.id, 'GET', '/summary')).json.data);
    expect(s.monthsEarned).toBe(1);
    expect(s.proDaysTotal).toBe(30);
    expect(s.proUntil!.getTime()).toBeCloseTo(now + 20 * 86_400_000, -4);
    expect(s.recentRewards[0]).toMatchObject({ kind: 'month', side: 'referrer', friendName: 'Daniel S.' });
    // referee side
    const f = referralSummarySchema.parse((await call(fr.id, 'GET', '/summary')).json.data);
    expect(f.friends).toEqual([]);
    // Pro subscriber: no "Pro grátis até", credit instead
    await dbm.db.insert(dbm.subscriptions).values({ userId: ref.id, plan: 'pro', status: 'active', stripeSubscriptionId: 'sub_f18', renewsAt: new Date(now + 30 * 86_400_000) });
    await dbm.db.insert(dbm.billingCredits).values({ userId: ref.id, referralId: r!.id, amountCents: 2900 });
    s = referralSummarySchema.parse((await call(ref.id, 'GET', '/summary')).json.data);
    expect(s).toMatchObject({ proUntil: null, credit: 2900, monthsEarned: 2 });
    expect(s.recentRewards.some((x) => x.kind === 'credit' && x.amount === 2900)).toBe(true);
  });

  it('invites: hash + mask only, existing account silent, re-invite idempotent, no plaintext in db', async () => {
    const u = await newUser('Carla Dias');
    const existing = await newUser('Ja Tem');
    const mail = `Joao.Silva+x${uuid().slice(0, 6)}@gmail.com`.toLowerCase();
    const r = await call(u.id, 'POST', '/invites', { emails: [mail, existing.email] });
    expect(inviteResultSchema.parse(r.json.data)).toEqual({ sent: 2, invitesLeftToday: 18 });
    expect(sentTo(mail)).toHaveLength(1);
    expect(sentTo(mail)[0]!.subject).toContain('Carla');
    expect(sentTo(existing.email)).toHaveLength(0);
    // same person via other spelling of the gmail address: no new row, no new mail
    const again = await call(u.id, 'POST', '/invites', { emails: [mail.replace('joao.silva', 'joaosilva')] });
    expect(again.status).toBe(200);
    expect(sentTo(mail)).toHaveLength(1);
    expect(sentTo(mail.replace('joao.silva', 'joaosilva'))).toHaveLength(0);
    const rows = await dbm.db.execute<{ invited_email_hash: string; invited_email_masked: string }>(sql`select invited_email_hash, invited_email_masked from referrals where referrer_id = ${u.id}`);
    expect(rows).toHaveLength(2);
    for (const x of rows) {
      expect(x.invited_email_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.invited_email_masked).toMatch(/^.\*\*\*@/);
    }
    const dump = JSON.stringify(await dbm.db.execute(sql`select * from referrals where referrer_id = ${u.id}`));
    expect(dump).not.toContain('silva');
    expect(dump).not.toContain(existing.email);
    const s = referralSummarySchema.parse((await call(u.id, 'GET', '/summary')).json.data);
    expect(s.invitesLeftToday).toBe(18);
    expect((await call(u.id, 'POST', '/invites', { emails: [] })).status).toBe(422);
  });

  it('invites: 20 per profile-local day, whole request refused above', async () => {
    const u = await newUser('Eva Rocha');
    for (let i = 0; i < 4; i++) {
      const r = await call(u.id, 'POST', '/invites', { emails: Array.from({ length: 5 }, () => `l${uuid()}@lim.test`) });
      expect(r.status).toBe(200);
    }
    const over = await call(u.id, 'POST', '/invites', { emails: [`x${uuid()}@lim.test`] });
    expect(over.status).toBe(429);
    expect(over.json.error?.message).toBe('invite_daily_limit');
    const [n] = await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from referrals where referrer_id = ${u.id}`);
    expect(n!.n).toBe(20);
  });

  it('notifyRewardGranted mails both sides', async () => {
    const ref = await newUser('Gil Alves');
    const fr = await newUser('Hana Braga');
    const [r] = await dbm.db.insert(dbm.referrals).values({ referrerId: ref.id, refereeId: fr.id, channel: 'link', status: 'qualified', signedUpAt: new Date(), qualifiedAt: new Date() }).returning();
    await notify.notifyRewardGranted(r!.id);
    expect(sentTo(ref.email)[0]!.text).toContain('Hana');
    expect(sentTo(fr.email)[0]!.text).toContain('Gil');
  });
});
