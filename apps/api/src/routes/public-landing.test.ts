// Integration: needs local Supabase (DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicPriceBookSchema } from '../public/pricebook';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/public/waitlist, /v1/public/pricebook', () => {
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let mailer: typeof import('../account/mailer');
  const emails: string[] = [];
  const join = (email: string, ip: string, extra: object = {}) => {
    emails.push(email);
    return app.request('/v1/public/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
      body: JSON.stringify({ email, segment: 'y5_6', variant: '29', origin: 'landing', ...extra }),
    });
  };
  const rows = async (email: string) => dbm.db.select().from(dbm.waitlist).where(eq(dbm.waitlist.email, email));
  const mails = (email: string) => mailer.sentEmails().filter((m) => m.to === email);
  const ip = () => `203.0.113.${Math.floor(Math.random() * 250)}-${uuid().slice(0, 6)}`;

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    mailer = await import('../account/mailer');
    const { createApp } = await import('../app');
    const { createMockStripe } = await import('../billing/stripe');
    app = createApp({ webOrigin: 'http://web.test', verifyToken: async () => null, stripe: createMockStripe({ apiOrigin: 'http://api.test' }).port });
  });
  afterAll(async () => {
    for (const e of emails) await dbm.db.delete(dbm.waitlist).where(eq(dbm.waitlist.email, e));
  });

  it('stores once, sends one mail, duplicate is a silent success', async () => {
    const email = `${uuid()}@wl.test`;
    const a = ip();
    const first = await join(email, a);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, data: null });
    expect(await rows(email)).toHaveLength(1);
    expect(mails(email)).toHaveLength(1);
    const dup = await join(email, a);
    expect(dup.status).toBe(200);
    expect(await rows(email)).toHaveLength(1);
    expect(mails(email)).toHaveLength(1);
  });

  it('honeypot: 200 and nothing stored or sent', async () => {
    const email = `${uuid()}@wl.test`;
    expect((await join(email, ip(), { website: 'http://spam' })).status).toBe(200);
    expect(await rows(email)).toHaveLength(0);
    expect(mails(email)).toHaveLength(0);
  });

  it('invalid e-mail / variant is 422', async () => {
    const a = ip();
    expect((await join('nope', a)).status).toBe(422);
    expect((await join(`${uuid()}@wl.test`, a, { variant: 'abc' })).status).toBe(422);
  });

  it('6th request from one IP is 429', async () => {
    const a = ip();
    for (let i = 0; i < 5; i++) expect((await join(`${uuid()}@wl.test`, a)).status).toBe(200);
    const r = await join(`${uuid()}@wl.test`, a);
    expect(r.status).toBe(429);
    expect((await r.json()).error.code).toBe('rate_limited');
  });

  it('pricebook: shape, variant and founder flag', async () => {
    delete process.env.BETA_FOUNDER;
    const base = await (await app.request('/v1/public/pricebook')).json();
    expect(publicPriceBookSchema.parse(base.data)).toMatchObject({ currency: 'brl', founder: false });
    expect(base.data.variant).toBeUndefined();
    process.env.BETA_FOUNDER = '1';
    const v = await (await app.request('/v1/public/pricebook?v=29')).json();
    expect(v.data).toMatchObject({ monthly: { amount: 2900 }, founder: true, variant: '29' });
    expect(v.data.annual.amount % 100).toBe(0);
    delete process.env.BETA_FOUNDER;
    expect((await app.request('/v1/public/pricebook?v=99')).status).toBe(422);
  });
});
