// G18 F24 lane C1: Resend webhook, one-click unsubscribe, Supabase Send Email hook, /v1/dev/emails, e-mail cover, timezone replan.
// Integration: needs local Supabase (see account.test.ts); the pure parts run without it.
import { config } from 'dotenv';
import { randomBytes, randomUUID as uuid } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emailHash } from '../referral/email-normalize';
import { signForTest, verifySigned } from './signature';
import { signUnsubscribeToken, unsubscribeUrl } from './tokens';
import { verifyUrl } from './auth-hook';
import type { OutgoingEmail } from './send';

config({ path: '../../.env' });

const secret = () => `whsec_${randomBytes(24).toString('base64')}`;

describe('signature (Standard Webhooks / Svix)', () => {
  const s = secret();
  const body = JSON.stringify({ a: 1 });
  it('accepts a valid one, refuses a wrong secret, a changed body, an old or future timestamp, missing headers', () => {
    const now = new Date();
    expect(verifySigned(s, signForTest(s, 'msg_1', now, body), body)).toEqual({ a: 1 });
    expect(verifySigned(`v1,${s}`, signForTest(s, 'msg_1', now, body), body)).toEqual({ a: 1 }); // Supabase secret format
    expect(verifySigned(secret(), signForTest(s, 'msg_1', now, body), body)).toBeNull();
    expect(verifySigned(s, signForTest(s, 'msg_1', now, body), body.replace('1', '2'))).toBeNull();
    expect(verifySigned(s, signForTest(s, 'msg_1', new Date(now.getTime() - 10 * 60_000), body), body)).toBeNull();
    expect(verifySigned(s, signForTest(s, 'msg_1', new Date(now.getTime() + 10 * 60_000), body), body)).toBeNull();
    expect(verifySigned(s, { ...signForTest(s, 'msg_1', now, body), signature: undefined }, body)).toBeNull();
    expect(verifySigned(undefined, signForTest(s, 'msg_1', now, body), body)).toBeNull();
  });
  it('verify link: Supabase URL from the .env, token_hash, type and redirect_to', () => {
    const u = new URL(verifyUrl('http://127.0.0.1:54321/', 'pkce_abc', 'recovery', 'http://localhost:3000/auth/callback?next=%2Fx'));
    expect(u.origin + u.pathname).toBe('http://127.0.0.1:54321/auth/v1/verify');
    expect(Object.fromEntries(u.searchParams)).toEqual({ token: 'pkce_abc', type: 'recovery', redirect_to: 'http://localhost:3000/auth/callback?next=%2Fx' });
  });
  it('unsubscribe URLs point at /v1/emails/unsubscribe on API_ORIGIN', () => {
    expect(unsubscribeUrl({ userId: uuid() }, 'calendar_d1')).toMatch(/^http:\/\/localhost:\d+\/v1\/emails\/unsubscribe\?token=[\w-]+\.calendar_d1\.[\w-]+$/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('e-mail routes (local Supabase)', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let sent: OutgoingEmail[];
  const exec = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>) => (await dbm.db.execute(q)) as unknown as T[];
  const newUser = async (email = `c1-${uuid()}@test.local`) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role) values (${id}, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    return { id, email };
  };
  const RESEND = secret();
  const HOOK = `v1,${secret()}`;

  beforeAll(async () => {
    process.env.RESEND_WEBHOOK_SECRET = RESEND;
    process.env.SEND_EMAIL_HOOK_SECRET = HOOK;
    dbm = await import('@remoa/db');
    sent = (await import('../test-email')).captureEmails();
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.SEND_EMAIL_HOOK_SECRET;
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  // ------------------------------------------------------------------ webhook
  describe('POST /v1/emails/webhook', () => {
    const post = (event: unknown, opts: { at?: Date; key?: string; id?: string } = {}) => {
      const body = JSON.stringify(event);
      const h = signForTest(opts.key ?? RESEND, opts.id ?? `msg_${uuid()}`, opts.at ?? new Date(), body);
      return app.request('/v1/emails/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'svix-id': h.id!, 'svix-timestamp': h.timestamp!, 'svix-signature': h.signature! } });
    };
    const delivery = async (opts: { redirected?: boolean; hash?: string; status?: string } = {}) => {
      const providerId = `re_${uuid()}`;
      const hash = opts.hash ?? emailHash(`${uuid()}@test.local`);
      await dbm.db.execute(sql`insert into email_deliveries (template, reference, to_hash, provider_id, status, redirected, sent_at)
        values ('review-reminder', ${`c1:${uuid()}`}, ${hash}, ${providerId}, ${opts.status ?? 'sent'}, ${opts.redirected ?? false}, now())`);
      return { providerId, hash };
    };
    const state = async (providerId: string) => (await exec<{ status: string; delivered_at: Date | null; error: string | null }>(sql`select status, delivered_at, error from email_deliveries where provider_id = ${providerId}`))[0]!;
    const reason = async (hash: string) => (await exec<{ reason: string }>(sql`select reason from email_suppressions where email_hash = ${hash}`))[0]?.reason;
    const ev = (type: string, emailId: string, extra: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: ['x@y.z'], ...extra } });

    it('valid signature updates the delivery; delivered sets delivered_at; repeating the event is a no-op', async () => {
      const d = await delivery();
      const r = await post(ev('email.delivered', d.providerId));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, data: { outcome: 'updated' } });
      const first = await state(d.providerId);
      expect(first.status).toBe('delivered');
      expect(first.delivered_at).not.toBeNull();
      const again = await post(ev('email.delivered', d.providerId));
      expect(await again.json()).toEqual({ ok: true, data: { outcome: 'unchanged' } });
      // a late "delayed" never goes back from delivered
      expect(await (await post(ev('email.delivery_delayed', d.providerId))).json()).toEqual({ ok: true, data: { outcome: 'unchanged' } });
      expect((await state(d.providerId)).status).toBe('delivered');
    });

    it('invalid or old signature: 401 and nothing changes', async () => {
      const d = await delivery();
      expect((await post(ev('email.delivered', d.providerId), { key: secret() })).status).toBe(401);
      expect((await post(ev('email.delivered', d.providerId), { at: new Date(Date.now() - 6 * 60_000) })).status).toBe(401);
      const unsigned = await app.request('/v1/emails/webhook', { method: 'POST', body: JSON.stringify(ev('email.delivered', d.providerId)) });
      expect(unsigned.status).toBe(401);
      expect((await state(d.providerId)).status).toBe('sent');
    });

    it('hard bounce suppresses (hard_bounce); a soft bounce does not; complaint raises it; the reason never goes down', async () => {
      const soft = await delivery();
      await post(ev('email.bounced', soft.providerId, { bounce: { type: 'Transient', subType: 'MailboxFull', message: 'x' } }));
      expect(await state(soft.providerId)).toMatchObject({ status: 'bounced', error: 'bounce:Transient/MailboxFull' });
      expect(await reason(soft.hash)).toBeUndefined();

      const d = await delivery();
      await post(ev('email.bounced', d.providerId, { bounce: { type: 'Permanent', subType: 'General', message: 'x' } }));
      expect((await state(d.providerId)).status).toBe('bounced');
      expect(await reason(d.hash)).toBe('hard_bounce');
      await post(ev('email.bounced', d.providerId, { bounce: { type: 'Permanent', subType: 'General', message: 'x' } })); // repeated
      expect(await exec(sql`select 1 from email_suppressions where email_hash = ${d.hash}`)).toHaveLength(1);

      const d2 = await delivery({ hash: d.hash });
      await post(ev('email.complained', d2.providerId));
      expect(await reason(d.hash)).toBe('complaint');
      const d3 = await delivery({ hash: d.hash });
      await post(ev('email.bounced', d3.providerId, { bounce: { type: 'Permanent', subType: 'General', message: 'x' } }));
      expect(await reason(d.hash)).toBe('complaint'); // only up

      // invite_opt_out (F18) is the lowest: a hard bounce raises it
      const opted = emailHash(`${uuid()}@test.local`);
      await dbm.db.execute(sql`insert into email_suppressions (email_hash, reason) values (${opted}, 'invite_opt_out')`);
      const d4 = await delivery({ hash: opted });
      await post(ev('email.bounced', d4.providerId, { bounce: { type: 'Permanent', subType: 'General', message: 'x' } }));
      expect(await reason(opted)).toBe('hard_bounce');
    });

    it('EMAIL_TEST_REDIRECT deliveries never suppress the real address; unknown ids and other events are acknowledged', async () => {
      const d = await delivery({ redirected: true });
      await post(ev('email.complained', d.providerId));
      expect((await state(d.providerId)).status).toBe('complained');
      expect(await reason(d.hash)).toBeUndefined();
      expect(await (await post(ev('email.delivered', `re_${uuid()}`))).json()).toEqual({ ok: true, data: { outcome: 'unknown_email' } });
      expect(await (await post(ev('email.opened', d.providerId))).json()).toEqual({ ok: true, data: { outcome: 'ignored' } });
    });
  });

  // ------------------------------------------------------------------ unsubscribe
  describe('GET/POST /v1/emails/unsubscribe', () => {
    const get = (token: string, base = '/v1/emails/unsubscribe') => app.request(`${base}?token=${encodeURIComponent(token)}`);
    const oneClick = (token: string, base = '/v1/emails/unsubscribe') =>
      app.request(`${base}?token=${encodeURIComponent(token)}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const pref = async (userId: string, key: string) => (await exec<{ in_app: boolean; email: boolean }>(sql`select in_app, email from notification_preferences where user_id = ${userId} and key = ${key}`))[0];

    it('GET shows a confirm form (no state change, no personal data); POST one-click turns the e-mail off and keeps the bell', async () => {
      const u = await newUser();
      const token = signUnsubscribeToken({ userId: u.id }, 'calendar_d1');
      const page = await get(token);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('method="post"');
      expect(html).toContain('os lembretes de compromisso na véspera');
      expect(html).not.toContain(u.email);
      expect(await pref(u.id, 'calendar_d1')).toBeUndefined();
      const done = await oneClick(token);
      expect(done.status).toBe(200);
      expect(await pref(u.id, 'calendar_d1')).toEqual({ in_app: true, email: false });
      expect((await oneClick(token)).status).toBe(200); // idempotent
    });

    it('store also leaves the store waitlist; pause sets notif_pause_reminders', async () => {
      const u = await newUser();
      await dbm.db.execute(sql`insert into store_waitlist (user_id, email, wants_buy) values (${u.id}, ${u.email}, true)`);
      await oneClick(signUnsubscribeToken({ userId: u.id }, 'store'));
      expect(await exec(sql`select 1 from store_waitlist where user_id = ${u.id}`)).toHaveLength(0);
      expect(await pref(u.id, 'store')).toEqual({ in_app: true, email: false });
      await oneClick(signUnsubscribeToken({ userId: u.id }, 'pause'));
      expect((await exec<{ p: boolean }>(sql`select notif_pause_reminders as p from user_preferences where user_id = ${u.id}`))[0]?.p).toBe(true);
    });

    it('address scopes: referral_invite → invite_opt_out; landing_waitlist removes the address by hash', async () => {
      const addr = `C1.${uuid()}@Test.local`;
      await oneClick(signUnsubscribeToken({ emailHash: emailHash(addr) }, 'referral_invite'));
      expect((await exec<{ reason: string }>(sql`select reason from email_suppressions where email_hash = ${emailHash(addr)}`))[0]?.reason).toBe('invite_opt_out');
      await dbm.db.execute(sql`insert into waitlist (email) values (${addr})`);
      await oneClick(signUnsubscribeToken({ emailHash: emailHash(addr) }, 'landing_waitlist'));
      expect(await exec(sql`select 1 from waitlist where email = ${addr}`)).toHaveLength(0);
    });

    it('forged, garbage and fixed-row tokens: 422 page, nothing written; the legacy /v1/public route uses the same check', async () => {
      const u = await newUser();
      const good = signUnsubscribeToken({ userId: u.id }, 'map_ready');
      expect((await get(`${good.slice(0, -2)}xx`)).status).toBe(422);
      expect((await oneClick('x')).status).toBe(422);
      expect((await oneClick(signUnsubscribeToken({ userId: u.id }, 'account_billing'))).status).toBe(422);
      expect(await pref(u.id, 'account_billing')).toBeUndefined();
      expect((await get(good, '/v1/public/unsubscribe')).status).toBe(200);
      expect((await oneClick(good, '/v1/public/unsubscribe')).status).toBe(200);
      expect(await pref(u.id, 'map_ready')).toEqual({ in_app: true, email: false });
    });
  });

  // ------------------------------------------------------------------ Supabase Send Email hook
  describe('POST /v1/auth/send-email', () => {
    const hook = (payload: unknown, opts: { key?: string; id?: string } = {}) => {
      const body = JSON.stringify(payload);
      const h = signForTest(opts.key ?? HOOK, opts.id ?? `msg_${uuid()}`, new Date(), body);
      return app.request('/v1/auth/send-email', { method: 'POST', body, headers: { 'content-type': 'application/json', 'webhook-id': h.id!, 'webhook-timestamp': h.timestamp!, 'webhook-signature': h.signature! } });
    };
    const payload = (u: { id: string; email: string }, type: string, extra: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => ({
      user: { id: u.id, email: u.email, user_metadata: { name: 'Ana Souza' }, ...user },
      email_data: { token: '123456', token_hash: `th_${type}`, redirect_to: 'http://localhost:3000/auth/callback', email_action_type: type, site_url: 'http://localhost:3000', token_new: '', token_hash_new: '', ...extra },
    });
    const templateOf = (m: OutgoingEmail) => m.tags?.find((t) => t.name === 'template')?.value;
    const linkIn = (m: OutgoingEmail) => /http:\/\/[^\s"<>\]]+\/auth\/v1\/verify\?[^\s"<>\]]+/.exec(m.text)?.[0] ?? '';

    it('signup → account-confirm with the Supabase verify link; the user need not be committed yet (sent by address)', async () => {
      const u = { id: uuid(), email: `c1-${uuid()}@test.local` }; // not in auth.users: GoTrue's transaction is still open
      const r = await hook(payload(u, 'signup'));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({});
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(u.email);
      expect(templateOf(sent[0]!)).toBe('account-confirm');
      expect(sent[0]!.subject).toBe('Confirme seu e-mail e comece no Remoa');
      expect(sent[0]!.text).toContain('Ana');
      const link = new URL(linkIn(sent[0]!).replaceAll('&amp;', '&'));
      expect(link.origin).toBe(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin);
      expect(Object.fromEntries(link.searchParams)).toEqual({ token: 'th_signup', type: 'signup', redirect_to: 'http://localhost:3000/auth/callback' });
    });

    it('same webhook-id twice (Supabase retry) sends once', async () => {
      const u = { id: uuid(), email: `c1-${uuid()}@test.local` };
      const id = `msg_${uuid()}`;
      await hook(payload(u, 'invite'), { id });
      await hook(payload(u, 'invite'), { id });
      expect(sent).toHaveLength(1);
    });

    it('invalid signature → 401 in the Supabase error shape, nothing sent; bad payload → 400', async () => {
      const u = { id: uuid(), email: `c1-${uuid()}@test.local` };
      const r = await hook(payload(u, 'signup'), { key: `v1,${secret()}` });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: { http_code: 401, message: 'invalid signature' } });
      expect((await hook({ nope: true })).status).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('email_change (secure): current address gets token_hash_new, new address gets token_hash; plain: only the new one', async () => {
      const u = await newUser();
      const next = `c1-new-${uuid()}@test.local`;
      await hook(payload(u, 'email_change', { token_hash: 'th_for_new', token_hash_new: 'th_for_current' }, { new_email: next }));
      expect(sent.map((m) => [m.to, new URL(linkIn(m).replaceAll('&amp;', '&')).searchParams.get('token')])).toEqual([[u.email, 'th_for_current'], [next, 'th_for_new']]);
      expect(sent.every((m) => templateOf(m) === 'account-confirm' && m.text.includes('novo e-mail'))).toBe(true);
      sent.length = 0;
      await hook(payload(u, 'email_change', { token_hash: 'th_only' }, { new_email: next }));
      expect(sent.map((m) => m.to)).toEqual([next]);
    });

    it('recovery → password-reset; at most 3 per hour per address, the 4th answers 200 and sends nothing', async () => {
      const u = await newUser();
      for (let i = 0; i < 4; i++) expect(await (await hook(payload(u, 'recovery'))).json()).toEqual({});
      expect(sent).toHaveLength(3);
      expect(templateOf(sent[0]!)).toBe('password-reset');
      expect(sent[0]!.subject).toBe('Redefina sua senha do Remoa');
      expect(new URL(linkIn(sent[0]!).replaceAll('&amp;', '&')).searchParams.get('type')).toBe('recovery');
    });

    it('magiclink → sign-in link (account-confirm magiclink); unknown types are acknowledged without sending', async () => {
      const u = await newUser();
      await hook(payload(u, 'magiclink'));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe('Seu link para entrar no Remoa');
      expect(new URL(linkIn(sent[0]!).replaceAll('&amp;', '&')).searchParams.get('type')).toBe('magiclink');
      expect((await hook(payload(u, 'reauthentication'))).status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it('provider failure after the retries → 500 so Supabase reports it (the person can ask again)', async () => {
      const { setEmailTestHooks } = await import('./send');
      setEmailTestHooks({ transport: async () => { throw new Error('down'); }, sleep: async () => undefined });
      try {
        const r = await hook(payload({ id: uuid(), email: `c1-${uuid()}@test.local` }, 'signup'));
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: { http_code: 500, message: 'email provider failed' } });
      } finally {
        sent = (await import('../test-email')).captureEmails();
      }
    });
  });

  // ------------------------------------------------------------------ dev preview
  describe('GET /v1/dev/emails', () => {
    it('lists templates with versions and renders one; unknown → 404; production → 404', async () => {
      const list = (await (await app.request('/v1/dev/emails')).json()) as { data: { template: string; versions: string[] }[] };
      expect(list.data.find((t) => t.template === 'calendar-reminder')?.versions).toEqual(['d1', 'd0', 'varios']);
      expect(list.data.find((t) => t.template === 'map-ready')?.versions).toEqual(['default']);
      const one = await app.request('/v1/dev/emails/calendar-reminder/d1');
      expect(one.status).toBe(200);
      const { data } = (await one.json()) as { data: { subject: string; preheader: string; html: string; text: string; class: string; bytes: number } };
      expect(data).toMatchObject({ subject: 'Amanhã: Prova de Clínica Médica', class: 'reminder' });
      expect(data.bytes).toBe(Buffer.byteLength(data.html));
      expect(data.bytes).toBeLessThan(100_000);
      expect(data.text.length).toBeGreaterThan(50);
      expect((await app.request('/v1/dev/emails/calendar-reminder/nope')).status).toBe(404);
      expect((await app.request('/v1/dev/emails/nope/default')).status).toBe(404);
      const saved = { ...process.env };
      Object.assign(process.env, { NODE_ENV: 'production', EMAIL_PROVIDER: 'console', APP_URL: 'https://app.example.com', API_ORIGIN: 'https://api.example.com', EMAIL_FROM: 'Remoa <a@example.com>', EMAIL_UNSUBSCRIBE_SECRET: 'x'.repeat(32), CRON_SECRET: 'y'.repeat(32) });
      try {
        expect((await app.request('/v1/dev/emails')).status).toBe(404);
        expect((await app.request('/v1/dev/emails/map-ready/default')).status).toBe(404);
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    });
  });

  // ------------------------------------------------------------------ cover + timezone
  describe('calendar cover link (P-322) and editable timezone (P-323)', () => {
    const call = async (user: string, method: string, path: string, body?: unknown) => {
      const res = await app.request(`/v1${path}`, { method, headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as { data?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const newEvent = async (u: string, extra: Record<string, unknown> = {}) => {
      const labels = (await call(u, 'GET', '/calendar/labels')).json.data.labels as { id: string; systemKey: string }[];
      return (await call(u, 'POST', '/calendar/events', { title: 'Prova de CM', labelId: labels[0]!.id, date: day(5), startTime: '10:00', ...extra })).json.data as { id: string };
    };

    it('cover token: 302 to a signed URL of the 800 px WebP; forged, no cover or deleted → 404', async () => {
      const { coverUrlFor } = await import('../calendar/ics');
      const u = await newUser();
      const [asset] = await exec<{ id: string }>(sql`insert into assets (user_id, key, mime) values (${u.id}, ${`u/${u.id}/cover`}, 'image/webp') returning id`);
      const e = await newEvent(u.id, { coverAssetId: asset!.id });
      const url = new URL(coverUrlFor(e.id));
      expect(url.pathname).toMatch(/^\/v1\/public\/calendar\/cover\/[\w-]+\.[\w-]+$/);
      const res = await app.request(url.pathname);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain(`u/${u.id}/cover/w800.webp`);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect((await app.request(`${url.pathname.slice(0, -3)}abc`)).status).toBe(404);
      const bare = await newEvent(u.id);
      expect((await app.request(new URL(coverUrlFor(bare.id)).pathname)).status).toBe(404);
      await call(u.id, 'DELETE', `/calendar/events/${e.id}`);
      expect((await app.request(url.pathname)).status).toBe(404);
    });

    it('PATCH /account/profile {timezone} validates IANA and replans pending reminders to the new local 18:00', async () => {
      const u = await newUser();
      await dbm.db.execute(sql`insert into profiles (user_id, timezone) values (${u.id}, 'America/Sao_Paulo') on conflict (user_id) do update set timezone = 'America/Sao_Paulo'`);
      const e = await newEvent(u.id);
      const d1 = async () => (await exec<{ local: string }>(sql`
        select to_char(r.send_at at time zone p.timezone, 'HH24:MI') as local from calendar_reminders r join profiles p on p.user_id = r.user_id
        where r.event_id = ${e.id} and r.kind = 'd1' and r.status = 'scheduled'`))[0]?.local;
      const sendAt = async () => (await exec<{ s: string }>(sql`select send_at::text as s from calendar_reminders where event_id = ${e.id} and kind = 'd1'`))[0]!.s;
      expect(await d1()).toBe('18:00');
      const before = await sendAt();
      expect((await call(u.id, 'PATCH', '/account/profile', { timezone: 'Not/AZone' })).status).toBe(422);
      expect((await call(u.id, 'PATCH', '/account/profile', { timezone: '-03:00' })).status).toBe(422);
      const ok = await call(u.id, 'PATCH', '/account/profile', { timezone: 'Asia/Tokyo' });
      expect(ok.status).toBe(200);
      expect(ok.json.data.timezone).toBe('Asia/Tokyo');
      expect(await d1()).toBe('18:00');
      expect(await sendAt()).not.toBe(before);
    });
  });
});
