// F19 T3 /v1/admin (core routes, authorization of every admin route) + suspension in requireUser. Needs local Supabase.
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminMeSchema, auditPageSchema, formatAuditId } from '@remoa/contracts';
import { fakeToken, fakeVerifier } from '../admin/core/test-helpers';

config({ path: '../../.env' });
type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOT_FOUND = { error: { code: 'not_found', message: 'route not found' } };

describe.skipIf(!process.env.DATABASE_URL)('F19 /v1/admin core', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let supa: ReturnType<typeof import('../account/auth-admin').adminClient>;
  let app: ReturnType<typeof import('../app').createApp>;
  let mailer: typeof import('../account/mailer');
  let core: typeof import('../admin/core');

  const newUser = async (role: 'admin' | 'student' = 'student', name = 'Pessoa Teste') => {
    const { data, error } = await supa.auth.admin.createUser({ email: `f19-${uuid()}@test.local`, password: 'senha1234', email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    await dbm.db.update(dbm.profiles).set({ role, name }).where(eq(dbm.profiles.userId, data.user.id));
    return { id: data.user.id, email: data.user.email! };
  };
  const req = (path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const call = async (path: string, init: Parameters<typeof req>[1] = {}) => {
    const res = await req(path, init);
    return { status: res.status, res, json: (res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()) as Json };
  };
  const deniedRows = (actorId: string) =>
    dbm.db.select().from(dbm.adminAuditLog).where(and(eq(dbm.adminAuditLog.actorId, actorId), eq(dbm.adminAuditLog.action, 'admin.access')));

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    supa = (await import('../account/auth-admin')).adminClient();
    mailer = await import('../account/mailer');
    core = await import('../admin/core');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: fakeVerifier(users) });
  });
  afterAll(async () => {
    for (const id of users) await supa.auth.admin.deleteUser(id);
  });

  it('every registered /v1/admin route and unknown subpaths: 404 for student and unauthenticated, same body as a missing route', async () => {
    const student = await newUser();
    const routes = app.routes.filter((r) => r.path.startsWith('/v1/admin') && r.method !== 'ALL');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /v1/admin/me', 'GET /v1/admin/audit', 'POST /v1/admin/export']));
    const paths = [...routes.map((r) => [r.method, r.path.replace(/:[a-zA-Z]+/g, uuid())] as const), ['GET', '/v1/admin'], ['GET', '/v1/admin/nope/x'], ['DELETE', '/v1/admin/audit/1001']] as const;
    expect(await (await req('/v1/nope')).json()).toEqual(NOT_FOUND);
    for (const [method, path] of paths) {
      for (const token of [fakeToken(student.id), null, 'garbage']) {
        const r = await call(path, { method, token, body: method === 'GET' ? undefined : { reason: 'Motivo suficiente' } });
        expect([method, path, r.status, r.json]).toEqual([method, path, 404, NOT_FOUND]);
      }
    }
    // admin + unknown path = the same 404
    const admin = await newUser('admin');
    expect((await call('/v1/admin/nope/x', { token: fakeToken(admin.id) })).json).toEqual(NOT_FOUND);
  });

  it('non-admin hit writes one admin.access denied row per user + route per 10 min', async () => {
    const s = await newUser();
    await call('/v1/admin/audit', { token: fakeToken(s.id) });
    await call('/v1/admin/audit', { token: fakeToken(s.id) });
    await call('/v1/admin/users/x', { method: 'POST', token: fakeToken(s.id) });
    const rows = await deniedRows(s.id);
    expect(rows.map((r) => [r.actorType, r.targetType, r.targetId, r.result, r.denial]).sort()).toEqual([
      ['user', 'route', 'GET /v1/admin/audit', 'denied', 'not_admin'],
      ['user', 'route', 'POST /v1/admin/users/x', 'denied', 'not_admin'],
    ]);
  });

  it('suspended or deleted admin = non-admin (404)', async () => {
    const a = await newUser('admin');
    await dbm.db.update(dbm.profiles).set({ suspendedAt: new Date(), suspendedReason: 'teste' }).where(eq(dbm.profiles.userId, a.id));
    expect((await call('/v1/admin/me', { token: fakeToken(a.id) })).status).toBe(404);
    const b = await newUser('admin');
    await dbm.db.update(dbm.profiles).set({ deletedAt: new Date() }).where(eq(dbm.profiles.userId, b.id));
    expect((await call('/v1/admin/me', { token: fakeToken(b.id) })).status).toBe(404);
  });

  it('GET /me; 12 h session: everything else 403 reauth_required, /me still answers', async () => {
    const a = await newUser('admin', 'Fernanda Admin');
    const me = await call('/v1/admin/me', { token: fakeToken(a.id, 5 * 60_000) });
    expect(me.status).toBe(200);
    const m = adminMeSchema.parse(me.json.data);
    expect(m).toMatchObject({ id: a.id, name: 'Fernanda Admin', email: a.email });
    expect(Math.abs(m.authenticatedAt.getTime() - (Date.now() - 5 * 60_000))).toBeLessThan(2000);
    const old = fakeToken(a.id, 13 * 3_600_000);
    expect((await call('/v1/admin/me', { token: old })).status).toBe(200);
    expect((await call('/v1/admin/audit', { token: old })).json).toEqual({ error: { code: 'forbidden', message: 'reauth_required' } });
    expect((await call('/v1/admin/audit', { token: fakeToken(a.id, null) })).status).toBe(403);
    expect(new Date((await call('/v1/admin/me', { token: fakeToken(a.id, null) })).json.data.authenticatedAt).getTime()).toBe(0);
  });

  it('GET /audit: filters (actor, result, action, period), search, a_ id, pagination', async () => {
    const tag = uuid().slice(0, 8);
    const a = await newUser('admin', `Auditora Zeta ${tag}`); // unique: leftover admins from interrupted runs must not match
    const s = await newUser('student', 'Aluno Qualquer');
    await call('/v1/admin/me', { token: fakeToken(s.id) }); // denied row for s
    for (let i = 0; i < 3; i++)
      await core.writeAudit({ actorType: 'admin', actorId: a.id, action: 'user.suspend', targetType: 'user', targetId: s.id, reason: `Motivo ${tag} ${i}`, result: 'success' });
    const tok = fakeToken(a.id);
    const page = async (qs: string) => auditPageSchema.parse((await call(`/v1/admin/audit?${qs}`, { token: tok })).json.data);

    const mine = await page(`actorId=${a.id}&pageSize=2`);
    expect(mine.total).toBe(3);
    expect(mine.items).toHaveLength(2);
    expect(mine.items[0]!.reason).toBe(`Motivo ${tag} 2`); // newest first
    expect(mine.items[0]!.actor).toEqual({ id: a.id, name: `Auditora Zeta ${tag}`, email: a.email });
    expect(mine.items[0]!.targetLabel).toBe('Aluno Qualquer'); // user target -> profiles.name, same query
    expect((await page(`actorId=${a.id}&pageSize=2&page=2`)).items.map((e) => e.reason)).toEqual([`Motivo ${tag} 0`]);
    expect((await page(`q=${tag}`)).total).toBe(3);
    expect((await page(`q=${encodeURIComponent(`Auditora Zeta ${tag}`)}&action=user.suspend`)).total).toBe(3);
    const chips = await page(`q=${tag}&result=denied&actorType=system`); // summary ignores every filter but q
    expect(chips.total).toBe(0);
    expect(chips.summary).toEqual({ total: 3, admin: 3, system: 0, denied: 0 });
    expect((await page(`actorType=admin&actorId=${a.id}`)).total).toBe(3);
    expect((await page(`actorType=stripe&actorId=${a.id}`)).total).toBe(0);
    expect((await page(`q=${encodeURIComponent(a.email)}`)).total).toBe(3);
    expect((await page(`q=%25%25%25${tag}`)).total).toBe(0); // LIKE wildcards are literal
    const denied = await page(`actorId=${s.id}&result=denied`);
    expect(denied.items.map((e) => [e.action, e.denial])).toEqual([['admin.access', 'not_admin']]);
    expect((await page(`actorId=${a.id}&result=denied`)).total).toBe(0);
    const id = mine.items[0]!.id;
    expect((await page(`q=${formatAuditId(id)}`)).items.map((e) => e.id)).toEqual([id]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await page(`actorId=${a.id}&from=${future}`)).total).toBe(0);
    expect((await page(`actorId=${a.id}&to=${future}`)).total).toBe(3);
    expect((await call('/v1/admin/audit?pageSize=500', { token: tok })).status).toBe(422);
  });

  it('FR-21: more than 30 actions/min by one admin = 429 rate_limited; reads keep their own budget', async () => {
    const a = await newUser('admin');
    const tok = fakeToken(a.id);
    for (let i = 0; i < 30; i++) expect((await call('/v1/admin/nada', { method: 'POST', token: tok, body: {} })).status).toBe(404);
    const r = await call('/v1/admin/nada', { method: 'POST', token: tok, body: {} });
    expect([r.status, r.json.error?.code]).toEqual([429, 'rate_limited']);
    expect((await call('/v1/admin/me', { token: tok })).status).toBe(200);
  });

  it('POST /export audit: CSV + one export.csv row; missing reason 422 + denied; unregistered resource 404', async () => {
    const a = await newUser('admin');
    const tok = fakeToken(a.id);
    await core.writeAudit({ actorType: 'admin', actorId: a.id, action: 'map.archive', targetType: 'board', targetId: 'b1', reason: '=HYPERLINK("x")', result: 'success' });
    const r = await call('/v1/admin/export', { method: 'POST', token: tok, body: { reason: 'Relatório mensal', resource: 'audit', filters: { actorId: a.id } } });
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toContain('text/csv');
    const csv = r.json as unknown as string; // res.text() drops the BOM (unit-tested in toCsv)
    expect(csv.split('\r\n')[0]).toBe('id,quando,tipo_ator,ator,email_ator,acao,tipo_alvo,alvo,motivo,resultado,negacao,requisicao');
    expect(csv).toContain(`'=HYPERLINK(""x"")`);
    const auditId = Number(r.res.headers.get('x-audit-id'));
    const [row] = await dbm.db.select().from(dbm.adminAuditLog).where(eq(dbm.adminAuditLog.id, auditId));
    expect(row).toMatchObject({ action: 'export.csv', targetType: 'export', targetId: 'audit', result: 'success', after: { resource: 'audit', rows: 1, filters: { actorId: a.id } } });

    const bad = await call('/v1/admin/export', { method: 'POST', token: tok, body: { reason: 'curto', resource: 'audit' } });
    expect(bad.status).toBe(422);
    const bad2 = await call('/v1/admin/export', { method: 'POST', token: tok, body: { reason: 'Relatório mensal', resource: 'audit', filters: { result: 'talvez' } } });
    expect(bad2.status).toBe(422);
    const rows = await dbm.db.select().from(dbm.adminAuditLog).where(and(eq(dbm.adminAuditLog.actorId, a.id), eq(dbm.adminAuditLog.action, 'export.csv')));
    expect(rows.map((x) => [x.result, x.denial]).sort()).toEqual([['denied', 'error'], ['denied', 'missing_reason'], ['success', null]]);
    expect((await call('/v1/admin/export', { method: 'POST', token: tok, body: { reason: 'Relatório mensal', resource: 'nada' } })).status).toBe(422);
    if (!core.getExport('overview'))
      expect((await call('/v1/admin/export', { method: 'POST', token: tok, body: { reason: 'Relatório mensal', resource: 'overview' } })).status).toBe(404);
  });

  it('export of payments/users e-mails every admin (FR-21)', async () => {
    const a = await newUser('admin', 'Admin Alerta');
    const prev = core.getExport('payments');
    core.registerExport('payments', async () => ({ ok: true, data: { header: ['id'], rows: [['pi_1'], ['pi_2']] } }));
    try {
      const r = await call('/v1/admin/export', { method: 'POST', token: fakeToken(a.id), body: { reason: 'Conciliação do mês', resource: 'payments' } });
      expect(r.status).toBe(200);
      const mail = mailer.sentEmails().filter((m) => m.to === a.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe('Alerta: exportação de dados');
      expect(mail[0]!.text).toContain('2 transações');
    } finally {
      if (prev) core.registerExport('payments', prev);
    }
  });

  it('suspended user: 403 account_suspended on every /v1/* except GET /v1/account/me, immediately', async () => {
    const s = await newUser();
    const tok = fakeToken(s.id);
    expect((await call('/v1/me', { token: tok })).status).toBe(200);
    await dbm.db.update(dbm.profiles).set({ suspendedAt: new Date(), suspendedReason: 'abuso' }).where(eq(dbm.profiles.userId, s.id));
    for (const p of ['/v1/me', '/v1/home', '/v1/boards', '/v1/account/preferences'])
      expect([p, (await call(p, { token: tok })).json]).toEqual([p, { error: { code: 'forbidden', message: 'account_suspended' } }]);
    const me = await call('/v1/account/me', { token: tok });
    expect(me.json.error?.message).not.toBe('account_suspended');
    await dbm.db.update(dbm.profiles).set({ suspendedAt: null, suspendedReason: null }).where(eq(dbm.profiles.userId, s.id));
    expect((await call('/v1/me', { token: tok })).status).toBe(200);
  });
});
