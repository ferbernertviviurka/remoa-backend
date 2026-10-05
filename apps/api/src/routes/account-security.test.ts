// Integration: needs local Supabase (DB + Auth); skipped otherwise. Real GoTrue tokens, so session_id and revocation are real.
import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUserAgent } from '../account/events';
import { templateOf } from '../test-email';

config({ path: '../../.env' });

describe('parseUserAgent', () => {
  it('names browser and OS, with Edge/Opera before Chrome and iOS before macOS', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
    expect(parseUserAgent(`${mac} Chrome/130.0 Safari/537.36`)).toEqual({ browser: 'Chrome', os: 'macOS' });
    expect(parseUserAgent(`${mac} Version/18.0 Safari/605.1.15`)).toEqual({ browser: 'Safari', os: 'macOS' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0')).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile Safari/604.1')).toEqual({ browser: 'Chrome', os: 'iOS' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14) Firefox/131.0')).toEqual({ browser: 'Firefox', os: 'Android' });
    expect(parseUserAgent('node')).toEqual({ browser: null, os: null });
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null });
  });
});

const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE;

describe.skipIf(!live)('/v1/account password, sessions, D-123, export limit', () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE!, opts);
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let sent: Awaited<ReturnType<typeof import('../test-email')['captureEmails']>>;
  let app: ReturnType<typeof import('../app').createApp>;

  const PW = 'senha-antiga-1';
  const newUser = async () => {
    const email = `sec-${uuid()}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    return { id: data.user.id, email };
  };
  /** One sign-in = one auth.sessions row; the client keeps its refresh token. */
  const signIn = async (email: string, password = PW) => {
    const client = createClient(url, anonKey, opts);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { client, token: data.session!.access_token };
  };
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36' },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const sessionsOf = async (u: string) =>
    [...(await dbm.db.execute<{ id: string }>(sql`select id from auth.sessions where user_id = ${u}`))].map((r) => r.id);
  const events = async (u: string, type: 'password_change_failed' | 'password_changed' | 'export_requested' | 'session_revoked') =>
    (await dbm.db.select().from(dbm.accountEvents).where(and(eq(dbm.accountEvents.userId, u), eq(dbm.accountEvents.type, type)))).length;
  const refreshFails = async (client: SupabaseClient) => !!(await client.auth.refreshSession()).error;

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    sent = (await import('../test-email')).captureEmails();
    const { createApp, supabaseVerifier } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: supabaseVerifier(createClient(url, anonKey, opts)) });
  });
  afterAll(async () => {
    await Promise.all(users.map((u) => admin.auth.admin.deleteUser(u)));
  });

  it('refuses a weak new password without counting an attempt', async () => {
    const u = await newUser();
    const a = await signIn(u.email);
    const r = await call(a.token, 'POST', '/account/password', { currentPassword: PW, newPassword: 'abcdefgh' });
    expect(r.status).toBe(422);
    expect(r.json.error?.message).toBe('weak_password');
    expect(await events(u.id, 'password_change_failed')).toBe(0);
  });

  it('a wrong current password counts; the 6th attempt in the hour is 429 even with the right password', async () => {
    const u = await newUser();
    const a = await signIn(u.email);
    for (let i = 0; i < 5; i++) {
      const r = await call(a.token, 'POST', '/account/password', { currentPassword: `errada-${i}`, newPassword: 'senha-nova-123' });
      expect(r.status).toBe(422);
      expect(r.json.error?.message).toBe('wrong_password');
    }
    expect(await events(u.id, 'password_change_failed')).toBe(5);
    const sixth = await call(a.token, 'POST', '/account/password', { currentPassword: PW, newPassword: 'senha-nova-123' });
    expect(sixth.status).toBe(429);
    expect(sixth.json.error?.code).toBe('rate_limited');
    expect(await events(u.id, 'password_change_failed')).toBe(5); // a refused attempt does not extend the lockout
    expect(await sessionsOf(u.id)).toHaveLength(1);
  }, 30_000);

  it('changing the password revokes the other sessions, keeps the current one and e-mails a notice', async () => {
    const u = await newUser();
    const a = await signIn(u.email);
    const b = await signIn(u.email);
    const before = sent.length;
    expect((await call(a.token, 'GET', '/account/me')).json.data.passwordChangedAt).toBeNull();
    const r = await call(a.token, 'POST', '/account/password', { currentPassword: PW, newPassword: 'senha-nova-123' });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ revokedSessions: 1 }); // b only: the reauth session was already deleted
    expect(await refreshFails(b.client)).toBe(true);
    expect((await call(b.token, 'GET', '/account/sessions')).status).toBe(401);
    expect(await refreshFails(a.client)).toBe(false);
    expect((await call(a.token, 'GET', '/account/sessions')).status).toBe(200);
    expect(await sessionsOf(u.id)).toHaveLength(1);
    const mail = sent.slice(before).find((m) => m.to === u.email);
    expect(mail && templateOf(mail)).toBe('password-changed');
    expect(await events(u.id, 'password_changed')).toBe(1);
    expect((await call(a.token, 'GET', '/account/me')).json.data.passwordChangedAt).toEqual(expect.any(String)); // "Última alteração" (F13 FR-9)
    expect(await events(u.id, 'password_change_failed')).toBe(0); // success gives the slot back
    await expect(signIn(u.email, 'senha-nova-123')).resolves.toBeTruthy();
  }, 30_000);

  it('lists only own sessions; another user’s is 404; the current one cannot be revoked; others can', async () => {
    const x = await newUser();
    const y = await newUser();
    const x1 = await signIn(x.email);
    const x2 = await signIn(x.email);
    await signIn(y.email);
    const [ySession] = await sessionsOf(y.id);

    const list = await call(x1.token, 'GET', '/account/sessions');
    expect(list.status).toBe(200);
    const ids = (list.json.data as { id: string; current: boolean; browser: string | null }[]);
    expect(ids.map((s) => s.id).sort()).toEqual((await sessionsOf(x.id)).sort());
    expect(ids.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.json.data)).not.toMatch(/"ip"/);
    const current = ids.find((s) => s.current)!.id;

    expect((await call(x1.token, 'DELETE', `/account/sessions/${ySession}`)).status).toBe(404);
    expect(await sessionsOf(y.id)).toEqual([ySession]);
    expect((await call(x1.token, 'DELETE', '/account/sessions/not-a-uuid')).status).toBe(404);
    const self = await call(x1.token, 'DELETE', `/account/sessions/${current}`);
    expect(self.status).toBe(422);
    expect(self.json.error?.code).toBe('validation');

    const other = ids.find((s) => !s.current)!.id;
    expect((await call(x1.token, 'DELETE', `/account/sessions/${other}`)).status).toBe(200);
    expect(await refreshFails(x2.client)).toBe(true);
    expect(await sessionsOf(x.id)).toEqual([current]);

    await signIn(x.email);
    const rest = await call(x1.token, 'DELETE', '/account/sessions');
    expect(rest.json.data).toEqual({ count: 1 });
    expect(await sessionsOf(x.id)).toEqual([current]);
    expect(await sessionsOf(y.id)).toEqual([ySession]);
    expect(await events(x.id, 'session_revoked')).toBe(2);
  }, 30_000);

  it('D-123: during scheduled deletion only GET /me, POST /deletion/cancel and POST /export pass', async () => {
    const u = await newUser();
    const a = await signIn(u.email);
    await dbm.db.insert(dbm.profiles).values({ userId: u.id, deletedAt: new Date() }).onConflictDoUpdate({ target: dbm.profiles.userId, set: { deletedAt: new Date() } });
    const blocked = (r: { status: number; json: { error?: { message: string } } }) => r.status === 403 && r.json.error?.message === 'account_deleted';
    for (const [m, p] of [['GET', '/account/sessions'], ['DELETE', '/account/sessions'], ['POST', '/account/password'], ['POST', '/account/email'], ['PATCH', '/account/profile'], ['GET', '/boards'], ['GET', '/me'], ['GET', '/account/me/']] as const)
      expect(blocked(await call(a.token, m, p, {})), `${m} ${p}`).toBe(true);
    // cancel last: it clears deleted_at
    for (const [m, p] of [['GET', '/account/me'], ['POST', '/account/export'], ['POST', '/account/deletion/cancel']] as const)
      expect(blocked(await call(a.token, m, p)), `${m} ${p}`).toBe(false);
    expect(blocked(await call(a.token, 'GET', '/boards'))).toBe(false);
  }, 30_000);

  it('export: 1 per hour, 429 rate_limited after', async () => {
    const u = await newUser();
    const a = await signIn(u.email);
    expect((await call(a.token, 'POST', '/account/export')).status).toBe(200);
    const again = await call(a.token, 'POST', '/account/export');
    expect(again.status).toBe(429);
    expect(again.json.error?.code).toBe('rate_limited');
    expect(await events(u.id, 'export_requested')).toBe(1);
  }, 30_000);

  it('takeSlot: a parallel burst of 12 never lets more than the limit through; countEvents takes a window or a timestamp', async () => {
    const ev = await import('../account/events');
    const u = await newUser();
    const got = await Promise.all(Array.from({ length: 12 }, () => ev.takeSlot(u.id, 'email_change_resent', 5, 3_600_000)));
    const passed = got.filter(Boolean).length;
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThanOrEqual(5);
    expect(await ev.countEvents(u.id, 'email_change_resent', 3_600_000)).toBe(passed);
    expect(await ev.countEvents(u.id, 'email_change_resent', Date.now() - 3_600_000)).toBe(passed);
  });

  it('a token without session_id cannot use the session routes', async () => {
    const { createApp } = await import('../app');
    const u = await newUser();
    const bare = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === u.id ? t : null) });
    const res = await bare.request('/v1/account/sessions', { method: 'DELETE', headers: { authorization: `Bearer ${u.id}` } });
    expect(res.status).toBe(401);
  });
});
