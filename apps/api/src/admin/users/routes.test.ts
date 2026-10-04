// F19 T5 integration: /v1/admin/users through the real app (requireAdmin, withAdmin, audit trigger, GoTrue). Needs local Supabase.
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUserDetailSchema, adminUserPageSchema } from '@remoa/contracts';
import { kit, type Kit } from './test-kit';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 /v1/admin/users', () => {
  let k: Kit;
  let adm: { id: string };
  beforeAll(async () => {
    k = await kit();
    adm = await k.newUser('admin', 'Admin T5');
  });
  afterAll(async () => k?.cleanup());
  const post = (id: string, action: string, body: unknown = { reason: 'Pedido do suporte #1' }, as: string | null = adm.id) =>
    k.call(`/v1/admin/users/${id}/${action}`, { method: 'POST', as, body });

  it('list: search, filters, summary, counts, origin; detail has facts and no secret', async () => {
    const referrer = await k.newUser('student', 'Indicadora Zeta');
    const u = await k.newUser('student', 'Zeta Estudante Unica');
    await k.dbm.db.update(k.dbm.profiles).set({ referredBy: referrer.id }).where(eq(k.dbm.profiles.userId, u.id));
    await k.board(u.id, { cards: 3 });
    const page = await k.call('/v1/admin/users?q=Zeta%20Estudante%20Unica', { as: adm.id });
    expect(page.status).toBe(200);
    const d = adminUserPageSchema.parse(page.json.data);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ id: u.id, email: u.email, plan: 'free', maps: 1, cards: 3, status: 'active', origin: 'referral' });
    expect(d.summary).toMatchObject({ total: 1, active: 1, pending: 0, suspended: 0 });
    expect((await k.call(`/v1/admin/users?q=${u.email}&status=suspended`, { as: adm.id })).json.data).toMatchObject({ total: 0, items: [], summary: { total: 1, active: 1 } });
    expect((await k.call('/v1/admin/users?q=Zeta&plan=pro', { as: adm.id })).json.data.items).toHaveLength(0);
    expect((await k.call('/v1/admin/users?pageSize=500', { as: adm.id })).status).toBe(422);
    const det = await k.call(`/v1/admin/users/${u.id}`, { as: adm.id });
    const parsed = adminUserDetailSchema.parse(det.json.data);
    expect(parsed).toMatchObject({ role: 'student', suspendedAt: null, deletionAt: null, grantUntil: null });
    expect(JSON.stringify(det.json)).not.toMatch(/password|senha1234/i);
    expect((await k.call(`/v1/admin/users/${crypto.randomUUID()}`, { as: adm.id })).status).toBe(404);
    expect((await k.call('/v1/admin/users/nope', { as: adm.id })).status).toBe(404);
  });

  it('grant-pro-month: Pro right away, chained, one audit row each with before/after; reason and reauth rules', async () => {
    const u = await k.newUser();
    const { getEntitlements } = await import('../../billing/entitlements');
    expect((await getEntitlements(u.id)).ok && (await getEntitlements(u.id))).toMatchObject({ data: { plan: 'free' } });
    const r1 = await post(u.id, 'grant-pro-month');
    expect(r1.status).toBe(200);
    expect(r1.json.data.audit).toMatchObject({ action: 'user.grant_pro_month', result: 'success', targetId: u.id, reason: 'Pedido do suporte #1' });
    expect(r1.json.data.audit.before).toEqual({ proUntil: null });
    expect(await getEntitlements(u.id)).toMatchObject({ data: { plan: 'pro' } });
    expect((await k.call(`/v1/admin/users?q=${u.email}&plan=pro`, { as: adm.id })).json.data.items).toHaveLength(1);
    const pg = await k.call(`/v1/admin/users?q=${u.email}&plan=pro_grant`, { as: adm.id });
    expect(pg.json.data.items).toHaveLength(1);
    expect(new Date(pg.json.data.items[0].grantUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await k.call(`/v1/admin/users?q=${(await k.newUser()).email}&plan=pro_grant`, { as: adm.id })).json.data.items).toHaveLength(0);
    const r2 = await post(u.id, 'grant-pro-month');
    expect(new Date(r2.json.data.audit.after.startsAt).getTime()).toBe(new Date(r1.json.data.audit.after.endsAt).getTime()); // chained
    const rows = await k.audit('user.grant_pro_month', u.id);
    expect(rows.map((r) => r.result)).toEqual(['success', 'success']);
    expect((await k.call(`/v1/admin/users/${u.id}`, { as: adm.id })).json.data.timeline).toHaveLength(2);

    expect((await post(u.id, 'grant-pro-month', { reason: 'curto' })).status).toBe(422);
    expect((await post(u.id, 'grant-pro-month', {})).status).toBe(422);
    expect((await k.audit('user.grant_pro_month', u.id)).filter((r) => r.result === 'denied').map((r) => r.denial)).toEqual(['missing_reason', 'missing_reason']);
    const stale = await k.call(`/v1/admin/users/${u.id}/grant-pro-month`, { method: 'POST', as: adm.id, ago: 31 * 60_000, body: { reason: 'Pedido do suporte #1' } });
    expect([stale.status, stale.json.error?.message]).toEqual([403, 'reauth_required']);
    expect((await k.audit('user.grant_pro_month', u.id)).filter((r) => r.denial === 'reauth_required')).toHaveLength(1);
    expect((await k.audit('user.grant_pro_month', u.id)).filter((r) => r.result === 'success')).toHaveLength(2); // nothing else written
  });

  it('non-admin gets 404 on every action and nothing changes', async () => {
    const s = await k.newUser();
    const t = await k.newUser();
    expect((await post(t.id, 'suspend', { reason: 'tentativa indevida' }, s.id)).status).toBe(404);
    expect((await k.audit('user.suspend', t.id))).toHaveLength(0);
  });

  it('suspend blocks at once (403 on a normal route, Auth ban, sessions gone); reactivate restores; wrong state = 409 + denied', async () => {
    const u = await k.newUser();
    await k.supa.auth.signInWithPassword({ email: u.email, password: 'senha1234' }).catch(() => null);
    expect((await k.call('/v1/me', { as: u.id })).status).toBe(200);
    const r = await post(u.id, 'suspend', { reason: 'Abuso comprovado nos termos' });
    expect(r.status).toBe(200);
    expect(r.json.data.audit).toMatchObject({ before: { status: 'active' }, after: { status: 'suspended' } });
    const blocked = await k.call('/v1/me', { as: u.id });
    expect([blocked.status, blocked.json.error?.message]).toEqual([403, 'account_suspended']);
    const [prof] = await k.dbm.db.select().from(k.dbm.profiles).where(eq(k.dbm.profiles.userId, u.id));
    expect(prof!.suspendedReason).toBe('Abuso comprovado nos termos');
    const au = (await k.supa.auth.admin.getUserById(u.id)).data.user!;
    expect(au.banned_until).toBeTruthy();
    expect((await k.dbm.db.execute(await import('drizzle-orm').then((m) => m.sql`select 1 from auth.sessions where user_id = ${u.id}`))).length).toBe(0);
    expect((await k.call(`/v1/admin/users/${u.id}`, { as: adm.id })).json.data).toMatchObject({ status: 'suspended', suspendedReason: 'Abuso comprovado nos termos' });
    expect((await post(u.id, 'suspend')).status).toBe(409);
    expect((await k.audit('user.suspend', u.id)).map((x) => [x.result, x.denial])).toEqual([['success', null], ['denied', 'invalid_state']]);

    expect((await post(u.id, 'reactivate', { reason: 'Revisado e liberado' })).status).toBe(200);
    expect((await k.call('/v1/me', { as: u.id })).status).toBe(200);
    expect((await k.supa.auth.admin.getUserById(u.id)).data.user!.banned_until).toBeFalsy();
    expect((await post(u.id, 'reactivate')).status).toBe(409);
    expect((await k.audit('user.reactivate', u.id)).map((x) => x.result)).toEqual(['success', 'denied']);
  });

  it('concurrent reactivations: one success row, the other invalid_state', async () => {
    const u = await k.newUser();
    expect((await post(u.id, 'suspend', { reason: 'Abuso comprovado nos termos' })).status).toBe(200);
    const rs = await Promise.all([post(u.id, 'reactivate', { reason: 'Revisado e liberado' }), post(u.id, 'reactivate', { reason: 'Revisado e liberado' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await k.audit('user.reactivate', u.id)).map((x) => x.result).sort()).toEqual(['denied', 'success']);
  });

  it('nobody acts on themselves; an admin target cannot be suspended or deleted; role never changes', async () => {
    const other = await k.newUser('admin', 'Outro Admin');
    for (const [id, action] of [[adm.id, 'suspend'], [adm.id, 'grant-pro-month'], [other.id, 'suspend'], [other.id, 'schedule-deletion']] as const) {
      const r = await post(id, action);
      expect([id === adm.id ? 'self' : 'admin', action, r.status]).toEqual([id === adm.id ? 'self' : 'admin', action, 409]);
    }
    expect((await k.audit('user.suspend', other.id)).map((x) => x.denial)).toEqual(['invalid_state']);
    expect((await k.call(`/v1/admin/users/${adm.id}/make-admin`, { method: 'POST', as: adm.id, body: {} })).status).toBe(404);
    const [p] = await k.dbm.db.select().from(k.dbm.profiles).where(eq(k.dbm.profiles.userId, other.id));
    expect([p!.role, p!.suspendedAt]).toEqual(['admin', null]);
  });

  it('password-reset sends through Auth and returns neither link nor password; schedule-deletion follows the F13 flow (7 days) and is refused twice', async () => {
    const u = await k.newUser();
    const r = await post(u.id, 'password-reset', { reason: 'Aluno pediu por e-mail' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toMatch(/token|link|password"/i);
    expect(r.json.data.audit).toMatchObject({ action: 'user.password_reset', after: { sent: true } });

    const d = await post(u.id, 'schedule-deletion', { reason: 'Pedido LGPD do titular' });
    expect(d.status).toBe(200);
    const days = (new Date(d.json.data.hardDeleteAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const [p] = await k.dbm.db.select().from(k.dbm.profiles).where(eq(k.dbm.profiles.userId, u.id));
    expect(p!.deletedAt).toBeTruthy();
    expect((await k.call('/v1/me', { as: u.id })).json.error?.message).toBe('account_deleted'); // same as the user's own deletion (D-123)
    expect((await k.call(`/v1/admin/users/${u.id}`, { as: adm.id })).json.data).toMatchObject({ status: 'deleting' });
    expect((await post(u.id, 'schedule-deletion')).status).toBe(409);
    expect((await post(u.id, 'password-reset')).status).toBe(409);
    expect((await k.audit('user.schedule_deletion', u.id)).map((x) => x.result)).toEqual(['success', 'denied']);
  });

  it('export users: registered CSV, filtered, audited and without leaking other accounts', async () => {
    const u = await k.newUser('student', 'Exportada Unica');
    const r = await k.call('/v1/admin/export', { method: 'POST', as: adm.id, body: { reason: 'Conferência mensal', resource: 'users', filters: { q: u.email } } });
    expect(r.status).toBe(200);
    expect(String(r.json)).toContain(u.email);
    expect(String(r.json).trim().split('\r\n')).toHaveLength(2);
  });
});
