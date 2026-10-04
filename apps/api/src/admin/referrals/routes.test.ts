// F19 T5 integration: /v1/admin/referrals (approve grants both sides once, reject, revoke). Needs local Supabase.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminReferralDetailSchema, adminReferralPageSchema } from '@remoa/contracts';
import { kit, type Kit } from '../users/test-kit';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 /v1/admin/referrals', () => {
  let k: Kit;
  let adm: { id: string };
  beforeAll(async () => {
    k = await kit();
    adm = await k.newUser('admin', 'Admin Indica');
  });
  afterAll(async () => k?.cleanup());
  const post = (id: string, action: string, body: unknown = { reason: 'Conferido manualmente' }) => k.call(`/v1/admin/referrals/${id}/${action}`, { method: 'POST', as: adm.id, body });
  const seed = async (status: 'signed_up' | 'rejected', reason: string | null = null) => {
    const referrer = await k.newUser('student', 'Indicador Alfa');
    const referee = await k.newUser('student', 'Indicado Beta');
    const [r] = await k.dbm.db.execute<{ id: string }>(sql`insert into referrals (referrer_id, referee_id, channel, status, reject_reason, signed_up_at)
      values (${referrer.id}, ${referee.id}, 'link', ${status}, ${reason}, now()) returning id`);
    return { id: r!.id, referrer, referee };
  };
  const grants = (id: string) => k.dbm.db.execute<{ user_id: string; revoked_at: Date | null; revoked_reason: string | null; id: string }>(sql`select id, user_id, revoked_at, revoked_reason from entitlement_grants where referral_id = ${id} order by user_id`);
  const planOf = async (id: string) => (await (await import('../../billing/entitlements')).getEntitlements(id) as { data: { plan: string } }).data.plan;

  it('list: in_review = rejected by velocity/fraud; filters, fraud signals, summary; detail with grants', async () => {
    const a = await seed('rejected', 'fraud_signals');
    const b = await seed('rejected', 'self_referral');
    const page = async (qs: string) => adminReferralPageSchema.parse((await k.call(`/v1/admin/referrals?${qs}`, { as: adm.id })).json.data);
    const review = await page(`q=${a.referrer.email}&status=in_review`);
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ id: a.id, status: 'in_review', fraudSignals: ['fraud_signals'], channel: 'link', rewardMonths: 0 });
    expect(review.items[0]!.referrer).toMatchObject({ id: a.referrer.id, name: 'Indicador Alfa' });
    expect((await page(`q=${b.referee.email}&status=rejected`)).items.map((i) => i.status)).toEqual(['rejected']);
    expect((await page(`q=${b.referee.email}&status=in_review`)).total).toBe(0);
    expect((await page(`q=${b.referee.email}&channel=email`)).total).toBe(0);
    expect((await page('')).summary.inReview).toBeGreaterThanOrEqual(1);
    expect((await k.call('/v1/admin/referrals?status=nope', { as: adm.id })).status).toBe(422);
    const { getExport } = await import('../core');
    const out = await k.dbm.db.transaction((tx) => getExport('referrals')!({ q: a.referrer.email }, tx));
    expect(out.ok && out.data.rows.map((r) => [r[0], r[6], r[7]])).toEqual([[a.id, 'in_review', 'fraud_signals']]);
    expect((await k.dbm.db.transaction((tx) => getExport('referrals')!({ status: 'x' }, tx))).ok).toBe(false);
    const d = adminReferralDetailSchema.parse((await k.call(`/v1/admin/referrals/${a.id}`, { as: adm.id })).json.data);
    expect(d).toMatchObject({ qualifiedAt: null, grants: [] });
    expect((await k.call(`/v1/admin/referrals/${crypto.randomUUID()}`, { as: adm.id })).status).toBe(404);
  });

  it('approve: qualifies and grants both sides once, even called twice at the same time; one success row, the loser is denied', async () => {
    const x = await seed('rejected', 'velocity_limit');
    const [r1, r2] = await Promise.all([post(x.id, 'approve'), post(x.id, 'approve')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const g = await grants(x.id);
    expect(g.map((r) => r.user_id).sort()).toEqual([x.referrer.id, x.referee.id].sort());
    expect(await planOf(x.referrer.id)).toBe('pro');
    expect(await planOf(x.referee.id)).toBe('pro');
    const rows = await k.audit('referral.approve', x.id);
    expect(rows.map((r) => r.result).sort()).toEqual(['denied', 'success']);
    const ok = rows.find((r) => r.result === 'success')!;
    expect(ok.before).toMatchObject({ status: 'rejected', rejectReason: 'velocity_limit' });
    expect(ok.after).toMatchObject({ status: 'qualified' });
    expect(rows.find((r) => r.result === 'denied')!.denial).toBe('invalid_state');
    const d = adminReferralDetailSchema.parse((await k.call(`/v1/admin/referrals/${x.id}`, { as: adm.id })).json.data);
    expect(d).toMatchObject({ status: 'qualified', rewardMonths: 2 });
    expect(d.qualifiedAt).toBeTruthy();
    expect((await post(x.id, 'approve')).status).toBe(409);
    expect((await grants(x.id))).toHaveLength(2);
    expect((await post(x.id, 'approve', {})).status).toBe(422);
  });

  it('revoke-grant: sets manual reason, drops Pro, refuses a second revoke, a foreign grant and a bad body; approve never re-grants a revoked grant', async () => {
    const x = await seed('rejected', 'fraud_signals');
    await post(x.id, 'approve');
    const [mine] = (await grants(x.id)).filter((g) => g.user_id === x.referee.id);
    const other = await seed('rejected', 'fraud_signals');
    await post(other.id, 'approve');
    const [foreign] = await grants(other.id);
    expect((await post(x.id, 'revoke-grant', { reason: 'Fraude confirmada', grantId: foreign!.id })).status).toBe(409);
    expect((await post(x.id, 'revoke-grant', { reason: 'Fraude confirmada', grantId: 'nope' })).status).toBe(422);
    const r = await post(x.id, 'revoke-grant', { reason: 'Fraude confirmada', grantId: mine!.id });
    expect(r.status).toBe(200);
    expect(r.json.data.audit).toMatchObject({ action: 'grant.revoke', targetType: 'grant', targetId: mine!.id, after: { revoked: true, revokedReason: 'manual' } });
    const after = (await grants(x.id)).find((g) => g.id === mine!.id)!;
    expect([!!after.revoked_at, after.revoked_reason]).toEqual([true, 'manual']);
    expect(await planOf(x.referee.id)).toBe('free');
    expect(await planOf(x.referrer.id)).toBe('pro');
    expect((await post(x.id, 'revoke-grant', { reason: 'Fraude confirmada', grantId: mine!.id })).status).toBe(409);
    expect((await post(x.id, 'revoke-grant', { reason: 'x', grantId: mine!.id })).status).toBe(422);
    expect((await post(x.id, 'approve')).status).toBe(409); // already qualified: no way to re-grant what was revoked
    expect(await planOf(x.referee.id)).toBe('free');
    const d = adminReferralDetailSchema.parse((await k.call(`/v1/admin/referrals/${x.id}`, { as: adm.id })).json.data);
    expect(d.rewardMonths).toBe(1);
    expect(d.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['grant.revoke', 'referral.approve']));
  });

  it('reject: signed_up or in_review only, final, no grants; a manual rejection can still be approved later', async () => {
    const s = await seed('signed_up');
    const r = await post(s.id, 'reject', { reason: 'Conta de teste do próprio indicador' });
    expect(r.status).toBe(200);
    expect(r.json.data.audit).toMatchObject({ before: { status: 'signed_up' }, after: { status: 'rejected', rejectReason: 'manual' } });
    expect(await grants(s.id)).toHaveLength(0);
    expect((await post(s.id, 'reject')).status).toBe(409);
    expect((await post(s.id, 'reject', {})).status).toBe(422);
    const q = await seed('rejected', 'fraud_signals');
    expect((await post(q.id, 'reject')).status).toBe(200);
    expect((await k.call(`/v1/admin/referrals?q=${q.referee.email}`, { as: adm.id })).json.data.items[0].status).toBe('rejected');
    expect((await post(s.id, 'approve')).status).toBe(200);
    expect(await grants(s.id)).toHaveLength(2);
    expect((await post(s.id, 'reject')).status).toBe(409); // qualified: revoke grants instead
    const inv = await seed('signed_up');
    await k.dbm.db.execute(sql`update referrals set status = 'qualified', qualified_at = now() where id = ${inv.id}`);
    expect((await post(inv.id, 'approve')).status).toBe(409);
    expect((await post(crypto.randomUUID(), 'approve')).status).toBe(404);
  });
});
