// F19 T3: withAdmin + requireAdmin + pure helpers. Integration part needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import { authenticatedAt, isFresh, takeDeniedSlot, type AdminEnv } from './require-admin';
import { ipHash } from './audit';
import { toCsv } from './export';
import { reasonOf } from './with-admin';
import { fakeToken, fakeVerifier } from './test-helpers';

config({ path: '../../.env' });
// D-537: XFF counts only through trusted hops; these requests model 2 proxy(ies) in front of the API.
vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
process.env.AUDIT_IP_SALT ||= 'test-salt-test-salt';

describe('admin core helpers', () => {
  it('authenticatedAt = max amr timestamp; garbage = null', () => {
    const t = `h.${Buffer.from(JSON.stringify({ amr: [{ timestamp: 100 }, { timestamp: 300 }, { timestamp: 'x' }] })).toString('base64url')}.s`;
    expect(authenticatedAt(t)).toBe(300_000);
    expect(authenticatedAt(fakeToken('u', null))).toBeNull();
    expect(authenticatedAt('nope')).toBeNull();
    expect(authenticatedAt(undefined)).toBeNull();
    expect(authenticatedAt(`h.${Buffer.from('{"amr":5}').toString('base64url')}.s`)).toBeNull();
  });
  it('isFresh', () => {
    expect(isFresh(null, 1000)).toBe(false);
    expect(isFresh(1000, 500, 1400)).toBe(true);
    expect(isFresh(1000, 500, 1600)).toBe(false);
  });
  it('ipHash: sha256 of ip + salt, null without salt or ip', () => {
    expect(ipHash('1.2.3.4', 's')).toMatch(/^[0-9a-f]{64}$/);
    expect(ipHash('1.2.3.4', 's')).not.toBe(ipHash('1.2.3.4', 't'));
    expect(ipHash('1.2.3.4', '')).toBeNull();
    expect(ipHash(undefined, 's')).toBeNull();
  });
  it('takeDeniedSlot: one per caller + route per 10 min, 20 per caller', () => {
    const k = uuid();
    expect(takeDeniedSlot(k, 'GET /a', 0)).toBe(true);
    expect(takeDeniedSlot(k, 'GET /a', 599_999)).toBe(false);
    expect(takeDeniedSlot(k, 'GET /a', 600_000)).toBe(true);
    const m = uuid();
    for (let i = 0; i < 20; i++) expect(takeDeniedSlot(m, `GET /${i}`, 1000)).toBe(true);
    expect(takeDeniedSlot(m, 'GET /x', 1000)).toBe(false);
    expect(takeDeniedSlot(m, 'GET /x', 601_000)).toBe(true);
  });
  it('toCsv quotes, neutralizes formulas, keeps numbers', () => {
    const csv = toCsv(['a', 'b'], [['=SUM(1)', -5], ['x,"y"', null], [new Date(0), 'linha\nnova']]);
    expect(csv).toBe(`\ufeffa,b\r\n'=SUM(1),-5\r\n"x,""y""",\r\n1970-01-01T00:00:00.000Z,"linha\nnova"\r\n`);
  });
  it('reasonOf', () => {
    expect(reasonOf({ reason: 'abc' })).toBe('abc');
    expect(reasonOf({ reason: 1 })).toBe('');
    expect(reasonOf(null)).toBe('');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('F19 withAdmin (integration)', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let supa: ReturnType<typeof import('../../account/auth-admin').adminClient>;
  let app: Hono<AdminEnv>;
  let adminId: string;
  let targetId: string;

  const newUser = async (role: 'admin' | 'student' = 'student') => {
    const { data, error } = await supa.auth.admin.createUser({ email: `f19-${uuid()}@test.local`, password: 'senha1234', email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    await dbm.db.update(dbm.profiles).set({ role, name: 'Antes' }).where(eq(dbm.profiles.userId, data.user.id));
    return data.user.id;
  };
  const rows = async (requestId: string) =>
    dbm.db.select().from(dbm.adminAuditLog).where(eq(dbm.adminAuditLog.requestId, requestId));
  const name = async () => (await dbm.db.select({ n: dbm.profiles.name }).from(dbm.profiles).where(eq(dbm.profiles.userId, targetId)))[0]?.n;
  const call = async (mode: string, reason: unknown, opts: { agoMs?: number; sensitive?: boolean } = {}) => {
    const requestId = uuid();
    const res = await app.request(`/v1/admin/t/${mode}${opts.sensitive === false ? '?insensitive=1' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fakeToken(adminId, opts.agoMs ?? 60_000)}`, 'x-request-id': requestId, 'x-forwarded-for': '10.0.0.1, 10.0.0.2', 'user-agent': 'vitest', 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    return { status: res.status, json: (await res.json()) as { data?: { audit: { id: number }; name: string }; error?: { code: string; message: string } }, rows: await rows(requestId) };
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    supa = (await import('../../account/auth-admin')).adminClient();
    const { requireAdmin } = await import('./require-admin');
    const { withAdmin, reasonOf: rOf, send } = await import('./with-admin');
    const { Abort } = await import('../../db');
    adminId = await newUser('admin');
    targetId = await newUser();
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('requestId', c.req.header('x-request-id')!);
      c.set('log', createLogger({ requestId: 'test' }));
      await next();
    });
    app.use('*', requireAdmin(fakeVerifier(users)));
    app.post('/v1/admin/t/:mode', async (c) => {
      const mode = c.req.param('mode');
      const body = await c.req.json();
      const r = await withAdmin(c, 'user.suspend', { reason: rOf(body), target: { type: 'user', id: targetId }, sensitive: c.req.query('insensitive') ? false : undefined }, async (tx, audit) => {
        const [p] = await tx.select({ name: dbm.profiles.name }).from(dbm.profiles).where(eq(dbm.profiles.userId, targetId));
        audit.before({ name: p!.name });
        await tx.update(dbm.profiles).set({ name: 'Depois' }).where(eq(dbm.profiles.userId, targetId));
        audit.after({ name: 'Depois' });
        if (mode === 'conflict') return err('conflict', 'invalid_state');
        if (mode === 'fail') return err('validation', 'bad');
        if (mode === 'abort') throw new Abort({ code: 'conflict', message: 'invalid_state' });
        if (mode === 'throw') throw new Error('boom');
        return ok({ name: 'Depois' });
      });
      if (r.ok) await dbm.db.update(dbm.profiles).set({ name: 'Antes' }).where(eq(dbm.profiles.userId, targetId)); // reset for the next case
      return send(r);
    });
    app.onError(() => Response.json({ error: { code: 'internal', message: 'internal error' } }, { status: 500 }));
  });
  afterAll(async () => {
    for (const id of users) await supa.auth.admin.deleteUser(id);
  });

  it('ok: exactly one success row with before/after, reason, actor, ip hash, user agent', async () => {
    const r = await call('ok', '  Pedido do aluno por e-mail  ');
    expect(r.status).toBe(200);
    expect(r.rows).toHaveLength(1);
    const [a] = r.rows;
    expect(a).toMatchObject({ actorType: 'admin', actorId: adminId, action: 'user.suspend', targetType: 'user', targetId, reason: 'Pedido do aluno por e-mail', result: 'success', denial: null, before: { name: 'Antes' }, after: { name: 'Depois' }, userAgent: 'vitest' });
    expect(a!.ipHash).toBe(ipHash('10.0.0.1'));
    expect(r.json.data).toMatchObject({ name: 'Depois', audit: { id: a!.id, result: 'success', actor: { id: adminId, name: 'Antes' } } });
  });

  it.each([
    ['conflict', 409, 'invalid_state'],
    ['abort', 409, 'invalid_state'],
    ['fail', 422, 'error'],
  ])('fn error (%s): rollback, zero success rows, one denied row', async (mode, status, denial) => {
    const r = await call(mode, 'Motivo suficiente');
    expect(r.status).toBe(status);
    expect(await name()).toBe('Antes');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ result: 'denied', denial, reason: 'Motivo suficiente', before: null, after: null });
  });

  it('throw: rollback, one denied error row, rethrown (500)', async () => {
    const r = await call('throw', 'Motivo suficiente');
    expect(r.status).toBe(500);
    expect(await name()).toBe('Antes');
    expect(r.rows.map((x) => [x.result, x.denial])).toEqual([['denied', 'error']]);
  });

  it.each([
    ['missing', undefined, null],
    ['empty', '   ', null],
    ['short', ' curto ', 'curto'],
  ])('reason %s: 422 + denied missing_reason, fn not run', async (_, reason, stored) => {
    const r = await call('ok', reason);
    expect(r.status).toBe(422);
    expect(await name()).toBe('Antes');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ result: 'denied', denial: 'missing_reason', reason: stored });
  });

  it('sensitive action with a sign-in older than 30 min: 403 reauth_required + denied; insensitive passes', async () => {
    const r = await call('ok', 'Motivo suficiente', { agoMs: 31 * 60_000 });
    expect(r.status).toBe(403);
    expect(r.json.error).toEqual({ code: 'forbidden', message: 'reauth_required' });
    expect(r.rows.map((x) => [x.result, x.denial])).toEqual([['denied', 'reauth_required']]);
    const i = await call('ok', 'Atendimento do chamado #1042', { agoMs: 31 * 60_000, sensitive: false });
    expect(i.status).toBe(200);
    expect(i.rows.map((x) => x.result)).toEqual(['success']);
  });

  it('admin session older than 12 h: 403 on actions, no row (the session gate is before withAdmin)', async () => {
    const r = await call('ok', 'Motivo suficiente', { agoMs: 13 * 3_600_000 });
    expect(r.status).toBe(403);
    expect(r.json.error?.message).toBe('reauth_required');
    expect(r.rows).toHaveLength(0);
  });

  it('the audit table refuses UPDATE, DELETE and TRUNCATE, even on the server connection', async () => {
    const r = await call('ok', 'Motivo suficiente');
    const id = r.rows[0]!.id;
    await expect(dbm.db.execute(sql`update admin_audit_log set reason = 'alterado!!' where id = ${id}`)).rejects.toThrow();
    await expect(dbm.db.update(dbm.adminAuditLog).set({ reason: 'alterado!!' }).where(eq(dbm.adminAuditLog.id, id))).rejects.toThrow();
    await expect(dbm.db.delete(dbm.adminAuditLog).where(eq(dbm.adminAuditLog.id, id))).rejects.toThrow();
    await expect(dbm.db.execute(sql`truncate admin_audit_log`)).rejects.toThrow();
    expect((await dbm.db.select().from(dbm.adminAuditLog).where(eq(dbm.adminAuditLog.id, id)))[0]?.reason).toBe('Motivo suficiente');
  });
});
