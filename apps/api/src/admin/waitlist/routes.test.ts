// CCR-020: /v1/admin/waitlist (404 for non-admin, audit row without e-mails, filters, CSV export). Needs local Supabase.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminWaitlistPageSchema } from '@remoa/contracts';
import { kit, type Kit } from '../users/test-kit';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 /v1/admin/waitlist', () => {
  let k: Kit;
  let adm: { id: string };
  const email = `wl-${Date.now()}@teste.com`;
  beforeAll(async () => {
    k = await kit();
    adm = await k.newUser('admin', 'Admin Lista');
    await k.dbm.db.execute(sql`insert into waitlist (email, segment, variant, source) values (${email}, 'y5_6', '29', 'landing')`);
  });
  afterAll(async () => {
    await k?.dbm.db.execute(sql`delete from waitlist where email = ${email}`);
    await k?.cleanup();
  });

  it('non-admin: 404 like an unknown route', async () => {
    const u = await k.newUser('student', 'Aluno');
    expect((await k.call('/v1/admin/waitlist', { as: u.id })).status).toBe(404);
  });

  it('admin lists with filters, writes one waitlist.view row and no e-mail in it', async () => {
    const before = (await k.audit('waitlist.view', '/v1/admin/waitlist')).length;
    const res = await k.call(`/v1/admin/waitlist?q=${email}&segment=y5_6`, { as: adm.id });
    expect(res.status).toBe(200);
    const page = adminWaitlistPageSchema.parse(res.json.data);
    expect(page.items).toEqual([expect.objectContaining({ email, segment: 'y5_6', variant: '29', origin: 'landing' })]);
    const rows = await k.audit('waitlist.view', '/v1/admin/waitlist');
    expect(rows.length).toBe(before + 1);
    expect(JSON.stringify(rows)).not.toContain(email);
    expect((await k.call('/v1/admin/waitlist?segment=nope', { as: adm.id })).status).toBe(422);
    const { getExport } = await import('../core');
    const out = await k.dbm.db.transaction((tx) => getExport('waitlist')!({ q: email }, tx));
    expect(out.ok && out.data.rows.map((r) => r[1])).toEqual([email]);
  });
});
