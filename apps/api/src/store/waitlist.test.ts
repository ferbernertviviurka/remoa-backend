// G16 / CCR-030: /v1/store/* and /v1/admin/store-waitlist. Needs local Supabase.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminStoreWaitlistSummarySchema, storeConfigSchema, storeWaitlistEntrySchema } from '@remoa/contracts';
import { captureEmails, templateOf } from '../test-email';
import { drainEmails } from '../emails/send';
import { kit, type Kit } from '../admin/users/test-kit';
import { getStoreConfig, takeStoreWaitlistSlot } from './waitlist';

config({ path: '../../.env' });

describe('store config', () => {
  it('defaults and falls back on bad env', () => {
    expect(getStoreConfig({})).toEqual({ status: 'soon', splitSellerPct: 85 });
    expect(getStoreConfig({ STORE_STATUS: 'open', STORE_SPLIT_SELLER_PCT: '65' } as NodeJS.ProcessEnv)).toEqual({ status: 'open', splitSellerPct: 65 });
    expect(getStoreConfig({ STORE_STATUS: 'x', STORE_SPLIT_SELLER_PCT: '150' } as NodeJS.ProcessEnv)).toEqual({ status: 'soon', splitSellerPct: 85 });
  });
  it('rate limit is per user', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) expect(takeStoreWaitlistSlot('u-rl', now)).toBe(true);
    expect(takeStoreWaitlistSlot('u-rl', now)).toBe(false);
    expect(takeStoreWaitlistSlot('u-other', now)).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('G16 store waitlist routes', () => {
  let k: Kit;
  const body = { email: 'Aluno@Teste.com', interest: ['buy', 'sell'], sellerRole: 'teacher', consent: true };
  beforeAll(async () => { k = await kit(); });
  afterAll(async () => { await k?.cleanup(); });

  it('needs a session', async () => {
    expect((await k.call('/v1/store/config')).status).toBe(401);
    expect((await k.call('/v1/store/waitlist')).status).toBe(401);
  });

  it('config, empty get, validated upsert, single row, e-mail only on first join, opt-out', async () => {
    const u = await k.newUser();
    expect(storeConfigSchema.parse((await k.call('/v1/store/config', { as: u.id })).json.data)).toEqual({ status: 'soon', splitSellerPct: 85 });
    expect((await k.call('/v1/store/waitlist', { as: u.id })).json.data).toBeNull();
    for (const bad of [{ ...body, consent: false }, { ...body, interest: [], sellerRole: null }, { ...body, sellerRole: null }, { ...body, interest: ['buy'] }, { ...body, email: 'nope' }]) {
      expect((await k.call('/v1/store/waitlist', { method: 'PUT', as: u.id, body: bad })).status).toBe(422);
    }
    const sent = captureEmails();
    const mails = () => sent.filter((m) => m.to === u.email && templateOf(m) === 'waitlist-confirm').length; // G18: to the account address, not the form's
    const put = await k.call('/v1/store/waitlist', { method: 'PUT', as: u.id, body });
    expect(put.status).toBe(200);
    expect(storeWaitlistEntrySchema.parse(put.json.data)).toMatchObject({ email: 'aluno@teste.com', interest: ['buy', 'sell'], sellerRole: 'teacher' });
    await drainEmails(5000); // G21 D-992: the provider call runs after the response
    expect(mails()).toBe(1);
    const again = await k.call('/v1/store/waitlist', { method: 'PUT', as: u.id, body: { ...body, interest: ['buy'], sellerRole: null } });
    expect(again.json.data).toMatchObject({ interest: ['buy'], sellerRole: null });
    await drainEmails(5000);
    expect(mails()).toBe(1);
    expect((await k.dbm.db.execute(sql`select 1 from store_waitlist where user_id = ${u.id}`)).length).toBe(1);
    expect((await k.call('/v1/store/waitlist', { method: 'DELETE', as: u.id })).status).toBe(200);
    expect((await k.call('/v1/store/waitlist', { method: 'DELETE', as: u.id })).status).toBe(200);
    expect((await k.call('/v1/store/waitlist', { as: u.id })).json.data).toBeNull();
  });

  it('admin: 404 for students, counts audited without e-mails, export audited with reason', async () => {
    const adm = await k.newUser('admin', 'Admin Loja');
    const [a, b] = [await k.newUser(), await k.newUser()];
    await k.call('/v1/store/waitlist', { method: 'PUT', as: a.id, body: { ...body, email: 'seller-x@teste.com' } });
    await k.call('/v1/store/waitlist', { method: 'PUT', as: b.id, body: { ...body, email: 'buyer-y@teste.com', interest: ['buy'], sellerRole: null } });
    expect((await k.call('/v1/admin/store-waitlist', { as: a.id })).status).toBe(404);
    const before = (await k.audit('store_waitlist.view', '/v1/admin/store-waitlist')).length;
    const res = await k.call('/v1/admin/store-waitlist', { as: adm.id });
    const s = adminStoreWaitlistSummarySchema.parse(res.json.data);
    expect(s.total).toBeGreaterThanOrEqual(2);
    expect(s.both).toBeGreaterThanOrEqual(1);
    expect(s.byRole.teacher).toBeGreaterThanOrEqual(1);
    const rows = await k.audit('store_waitlist.view', '/v1/admin/store-waitlist');
    expect(rows.length).toBe(before + 1);
    expect(JSON.stringify(rows)).not.toContain('@teste.com');

    expect((await k.call('/v1/admin/export', { method: 'POST', as: adm.id, body: { resource: 'store_waitlist' } })).status).toBe(422);
    const exp = await k.call('/v1/admin/export', { method: 'POST', as: adm.id, body: { resource: 'store_waitlist', reason: 'conferir inscritos vendedores', filters: { interest: 'sell' } } });
    expect(exp.status).toBe(200);
    expect(exp.json).toContain('seller-x@teste.com');
    expect(exp.json).not.toContain('buyer-y@teste.com');
    expect((await k.audit('export.csv', 'store_waitlist')).length).toBeGreaterThanOrEqual(1);
  });
});
