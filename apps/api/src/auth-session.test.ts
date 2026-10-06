// D-565: local JWT verification + one DB session query. Needs local Supabase (DB + Auth); skipped otherwise.
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID as uuid, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });
const live = !!process.env.DATABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe.skipIf(!live)('supabaseVerifier (D-565)', () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE!, opts);
  const users: string[] = [];
  let app: ReturnType<typeof import('./app').createApp>;
  let fakeApp: ReturnType<typeof import('./app').createApp>;
  let key: CryptoKeyPair;
  const kid = 'test-kid';

  /** A token signed by our own ES256 key, served as the JWKS of `fakeApp` (lets the test forge exp/claims). */
  const mint = async (claims: Record<string, unknown>) => {
    const head = `${b64({ alg: 'ES256', kid, typ: 'JWT' })}.${b64(claims)}`;
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(head));
    return `${head}.${Buffer.from(sig).toString('base64url')}`;
  };
  const signIn = async () => {
    const email = `authv-${uuid()}@test.local`;
    const { data: u, error } = await admin.auth.admin.createUser({ email, password: 'senha-teste-1', email_confirm: true });
    if (error) throw error;
    users.push(u.user.id);
    const client = createClient(url, anonKey, opts);
    const { data } = await client.auth.signInWithPassword({ email, password: 'senha-teste-1' });
    const token = data.session!.access_token;
    const sid = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).session_id as string;
    return { client, token, userId: u.user.id, sid };
  };
  const me = async (a: typeof app, token: string) => (await a.request('/v1/me', { headers: { authorization: `Bearer ${token}` } })).status;

  beforeAll(async () => {
    const { createApp, supabaseVerifier } = await import('./app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: supabaseVerifier(createClient(url, anonKey, opts)) });
    key = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = { ...(await webcrypto.subtle.exportKey('jwk', key.publicKey)), kid, alg: 'ES256', use: 'sig' };
    const fetchJwks: typeof fetch = async (input, init) =>
      String(input instanceof Request ? input.url : input).endsWith('/.well-known/jwks.json') ? Response.json({ keys: [jwk] }) : fetch(input, init);
    const fake = createClient('http://jwks.test', anonKey, { ...opts, global: { fetch: fetchJwks } });
    fakeApp = createApp({ webOrigin: 'http://localhost:3000', verifyToken: supabaseVerifier(fake) });
  });
  afterAll(async () => {
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });

  it('accepts a valid GoTrue token (local JWKS, live session)', async () => {
    const { token } = await signIn();
    expect(await me(app, token)).toBe(200);
  });

  it('rejects a tampered payload and a garbage token', async () => {
    const { token } = await signIn();
    const [h, p, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(await me(app, `${h}.${b64({ ...claims, exp: claims.exp + 86_400 })}.${s}`)).toBe(401);
    expect(await me(app, `${h}.${p}.${s!.slice(0, -4)}AAAA`)).toBe(401);
    expect(await me(app, 'not-a-jwt')).toBe(401);
  });

  it('rejects an expired token even with a valid signature and a live session', async () => {
    const { userId, sid } = await signIn();
    const now = Math.floor(Date.now() / 1000);
    expect(await me(fakeApp, await mint({ sub: userId, session_id: sid, role: 'authenticated', exp: now + 600 }))).toBe(200);
    expect(await me(fakeApp, await mint({ sub: userId, session_id: sid, role: 'authenticated', exp: now - 5 }))).toBe(401);
  });

  it('rejects a validly signed token without session_id or with an unknown session', async () => {
    const { userId } = await signIn();
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(await me(fakeApp, await mint({ sub: userId, role: 'authenticated', exp }))).toBe(401);
    expect(await me(fakeApp, await mint({ sub: userId, session_id: uuid(), role: 'authenticated', exp }))).toBe(401);
  });

  it('revocation is immediate: deleted session (D-124), sign-out and ban', async () => {
    const sessions = await import('./account/sessions');
    const a = await signIn();
    expect(await me(app, a.token)).toBe(200);
    await sessions.deleteSessions(a.userId, { only: a.sid });
    expect(await me(app, a.token)).toBe(401);

    const b = await signIn();
    await b.client.auth.signOut({ scope: 'local' });
    expect(await me(app, b.token)).toBe(401);

    const c = await signIn();
    await admin.auth.admin.updateUserById(c.userId, { ban_duration: '24h' });
    expect(await me(app, c.token)).toBe(401);
  });

  it('D-990: on a GET that opens run(), the session check rides in its first statement; revocation and ban still answer 401 at once', async () => {
    const sessions = await import('./account/sessions');
    const boards = async (t: string) => app.request('/v1/boards', { headers: { authorization: `Bearer ${t}` } });
    const a = await signIn();
    const ok = await boards(a.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('server-timing')).toMatch(/db;dur=/);
    await sessions.deleteSessions(a.userId, { only: a.sid });
    expect((await boards(a.token)).status).toBe(401);

    const c = await signIn();
    await admin.auth.admin.updateUserById(c.userId, { ban_duration: '24h' });
    expect((await boards(c.token)).status).toBe(401);
  });

  it('D-990: soft-deleted account: GET /v1/boards 403 account_deleted, GET /v1/account/me still allowed (D-123)', async () => {
    const { db } = await import('@remoa/db');
    const { sql } = await import('drizzle-orm');
    const a = await signIn();
    await db.execute(sql`update profiles set deleted_at = now() where user_id = ${a.userId}`);
    const res = await app.request('/v1/boards', { headers: { authorization: `Bearer ${a.token}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('account_deleted');
    expect((await app.request('/v1/account/me', { headers: { authorization: `Bearer ${a.token}` } })).status).not.toBe(403);
  });
});
