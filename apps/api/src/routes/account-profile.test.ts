// Integration: needs local Supabase (Auth, Mailpit on :54324); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDICAL_SCHOOLS, accountSnapshotSchema, type Notify } from '@remoa/contracts';

config({ path: '../../.env' });
process.env.UNSUBSCRIBE_SECRET ||= 'test-secret-test-secret';

const PASSWORD = 'senha1234';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
type Json = { data?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!process.env.DATABASE_URL)('F13 /v1/account profile, e-mail, identities, preferences, reminders', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let admin: ReturnType<typeof import('../account/auth-admin').adminClient>;
  let anonClient: typeof import('../account/auth-admin').anonClient;
  let reminders: typeof import('../account/reminders');
  let queue: typeof import('../review/queue');

  const newUser = async (opts: { pro?: boolean; tz?: string } = {}) => {
    const email = `f13-${uuid()}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw error;
    const id = data.user.id;
    users.push(id);
    if (opts.tz) await dbm.db.update(dbm.profiles).set({ timezone: opts.tz }).where(eq(dbm.profiles.userId, id)); // a trigger creates the profile row
    if (opts.pro) await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan: 'pro', status: 'active', stripeSubscriptionId: 'sub_x', renewsAt: new Date(Date.now() + 30 * 86_400_000) });
    return { id, email };
  };
  const call = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1${path}`, { method, headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const anon = () => anonClient();
  const mailTo = async (to: string) => {
    const m = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as { messages: { To: { Address: string }[]; Subject: string }[] };
    return m.messages.filter((x) => x.To.some((t) => t.Address === to));
  };
  const seedCard = async (u: string, n = 1) => {
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'b' }).returning();
    return dbm.db.insert(dbm.cards).values(Array.from({ length: n }, (_, i) => ({ boardId: board!.id, title: `c${i}`, order: i }))).returning();
  };
  const attempt = (u: string, cardId: string, at: Date) =>
    dbm.db.insert(dbm.attempts).values({ userId: u, cardId, mode: 'hidden_card', inputKind: 'text', grade: 3, createdAt: at });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    ({ anonClient } = await import('../account/auth-admin'));
    admin = (await import('../account/auth-admin')).adminClient();
    reminders = await import('../account/reminders');
    queue = await import('../review/queue');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('snapshot: Free with defaults, then Pro with prefs; parses the contract', async () => {
    const { id, email } = await newUser();
    const free = await call(id, 'GET', '/account/me');
    expect(free.status).toBe(200);
    const s = accountSnapshotSchema.parse(free.json.data);
    expect(s).toMatchObject({ email, emailConfirmed: true, pendingEmail: null, streakDays: null, deletionScheduledFor: null, avatarUrls: null, isAdmin: false });
    expect(s.entitlements.plan).toBe('free');
    expect(s.preferences).toMatchObject({ theme: 'light', reminderEnabled: false, reminderHour: 20, newCardsPerDay: 10 });
    expect(s.identities.map((i) => i.provider)).toEqual(['email']);
    expect(s.completeness).toEqual({ percent: 20, missing: ['photo', 'name', 'goal', 'reminder'] });

    const pro = await newUser({ pro: true });
    await call(pro.id, 'PATCH', '/account/profile', { name: '  Ana   Souza ', goal: 'enamed_2027_1', stage: 'y5_6' });
    await call(pro.id, 'PATCH', '/account/preferences', { reminderEnabled: true });
    const p = (await call(pro.id, 'GET', '/account/me')).json.data;
    expect(p.entitlements.plan).toBe('pro');
    await dbm.db.update(dbm.profiles).set({ role: 'admin' }).where(eq(dbm.profiles.userId, pro.id));
    expect((await call(pro.id, 'GET', '/account/me')).json.data.isAdmin).toBe(true); // D-471: rail item, no /v1/admin/me call
    await dbm.db.update(dbm.profiles).set({ suspendedAt: new Date(), suspendedReason: 'teste de suspensão' }).where(eq(dbm.profiles.userId, pro.id));
    expect((await call(pro.id, 'GET', '/account/me')).json.data.isAdmin).toBe(false); // same gate as requireAdmin
    await dbm.db.update(dbm.profiles).set({ role: 'student', suspendedAt: null, suspendedReason: null }).where(eq(dbm.profiles.userId, pro.id));
    expect(p.preferences.newCardsPerDay).toBeNull(); // D-647: Pro unlimited
    expect(p.profile).toMatchObject({ name: 'Ana Souza', goal: 'enamed_2027_1', stage: 'y5_6' });
    expect(p.completeness.percent).toBe(80); // email + name + goal + reminder
  });

  it('streak: consecutive study days in the profile tz, 04:00 rollover; unknown goal slug maps to null', async () => {
    const { id } = await newUser({ tz: 'America/Sao_Paulo' });
    const [c] = await seedCard(id);
    const now = Date.now();
    // 3 attempts on today, yesterday and 2 days ago (noon BRT = 15:00Z, safely inside each study day), then a gap
    const noon = (daysAgo: number) => {
      const d = new Date(now - daysAgo * 86_400_000);
      d.setUTCHours(15, 0, 0, 0);
      return d;
    };
    for (const d of [0, 1, 2, 4]) await attempt(id, c!.id, noon(d));
    await dbm.db.update(dbm.profiles).set({ goal: 'residencia_geral' }).where(eq(dbm.profiles.userId, id));
    const { getAccount } = await import('../account/profile');
    const { authInfoOf, loadAuthUser } = await import('../account/auth-admin');
    const info = authInfoOf((await loadAuthUser(id))!);
    // if the noon of "today" is still in the future, "today" has no attempt: the streak then runs from yesterday (3 -> 2 days + ...) so test with a fixed clock
    const clock = new Date(noon(0).getTime() + 3 * 3_600_000); // 18:00 BRT today
    const snap = await getAccount(id, info, clock);
    expect(snap.streakDays).toBe(3);
    expect(snap.profile.goal).toBeNull();
  });

  it('validates the name', async () => {
    const { id } = await newUser();
    for (const name of ['A', 'x'.repeat(61), '12345', 'Ana <b>', '   ']) expect((await call(id, 'PATCH', '/account/profile', { name })).status).toBe(422);
    expect((await call(id, 'PATCH', '/account/profile', {})).status).toBe(422);
    const ok = await call(id, 'PATCH', '/account/profile', { name: "Maria D'Ávila-Souza", avatarColor: 3 });
    expect(ok.json.data).toMatchObject({ name: "Maria D'Ávila-Souza", avatarColor: 3 });
  });

  it('G20: phone cannot be cleared; institution maps to school/school_id; snapshot returns them', async () => {
    const { id } = await newUser();
    const patch = (b: unknown) => call(id, 'PATCH', '/account/profile', b);
    const nullPhone = await patch({ phone: null });
    expect(nullPhone.status).toBe(422);
    expect(nullPhone.json.error?.code).toBe('validation');
    expect((await patch({ name: null })).status).toBe(422);
    const s = MEDICAL_SCHOOLS[0]!;
    expect((await patch({ institution: { schoolId: s.id, name: 'qualquer' } })).json.data).toMatchObject({ school: s.name, schoolId: s.id });
    expect((await patch({ institution: { schoolId: 'nao-existe', name: 'Xyz' } })).status).toBe(422);
    expect((await patch({ institution: { schoolId: null, name: 'Faculdade Livre' } })).json.data).toMatchObject({ school: 'Faculdade Livre', schoolId: null });
    const me = await call(id, 'GET', '/account/me');
    expect(accountSnapshotSchema.parse(me.json.data).profile).toMatchObject({ school: 'Faculdade Livre', schoolId: null });
    expect((await patch({ institution: null })).json.data).toMatchObject({ school: null, schoolId: null });
  });

  it('email change: wrong password, pending, resend limit, cancel, taken address stays generic', async () => {
    const a = await newUser();
    const b = await newUser();
    const next = `new-${uuid()}@test.local`;

    expect((await call(a.id, 'POST', '/account/email', { newEmail: next })).json.error?.message).toBe('password_required'); // Google-only path off (D-013)
    const wrong = await call(a.id, 'POST', '/account/email', { newEmail: next, currentPassword: 'errada123' });
    expect(wrong.status).toBe(422);
    expect((await call(a.id, 'GET', '/account/me')).json.data.pendingEmail).toBeNull();

    const other = (await anon().auth.signInWithPassword({ email: a.email, password: PASSWORD })).data.session!; // another device
    const r = await call(a.id, 'POST', '/account/email', { newEmail: next, currentPassword: PASSWORD });
    expect((await admin.auth.getUser(other.access_token)).error).toBeNull(); // still alive: only the reauth session ended
    expect(r.json.data).toEqual({ pendingEmail: next });
    const me = (await call(a.id, 'GET', '/account/me')).json.data;
    expect(me).toMatchObject({ email: a.email, pendingEmail: next });
    expect(me.completeness.missing).toContain('email');
    expect((await mailTo(next)).length).toBeGreaterThan(0); // link to the new address
    expect((await mailTo(a.email)).length).toBeGreaterThan(0); // double confirm: the old one is asked too

    expect((await call(a.id, 'POST', '/account/email/resend')).json.data).toEqual({ pendingEmail: next });
    const again = await call(a.id, 'POST', '/account/email/resend');
    expect(again.status).toBe(429);
    expect(again.json.error?.code).toBe('rate_limited');

    expect((await call(a.id, 'DELETE', '/account/email')).status).toBe(200);
    expect((await call(a.id, 'GET', '/account/me')).json.data.pendingEmail).toBeNull();
    expect((await call(a.id, 'POST', '/account/email/resend')).status).toBe(409);

    const taken = await call(a.id, 'POST', '/account/email', { newEmail: b.email, currentPassword: PASSWORD });
    expect(taken.status).toBe(422);
    expect(taken.json.error?.message).toBe('email_change_failed');
    const types = (await dbm.db.execute<{ type: string }>(sql`select type from account_events where user_id = ${a.id}`)).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['email_change_requested', 'email_change_resent', 'email_change_canceled', 'password_change_failed']));
  }, 30_000); // real GoTrue round-trips (bcrypt) under a loaded suite

  it('email change: parallel wrong passwords cannot exceed the 5/hour budget', async () => {
    const a = await newUser();
    const rs = await Promise.all(Array.from({ length: 8 }, () => call(a.id, 'POST', '/account/email', { newEmail: `p-${uuid()}@test.local`, currentPassword: 'errada123' })));
    // takeSlot may let fewer than 5 through in a burst, never more
    expect(rs.filter((r) => r.status === 422).length).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('email change is blocked during scheduled deletion (D-123)', async () => {
    const a = await newUser();
    await dbm.db.insert(dbm.profiles).values({ userId: a.id, deletedAt: new Date() }).onConflictDoUpdate({ target: dbm.profiles.userId, set: { deletedAt: new Date() } });
    const r = await call(a.id, 'POST', '/account/email', { newEmail: `x-${uuid()}@test.local`, currentPassword: PASSWORD });
    expect(r.status).toBe(403);
  });

  it('cancels a scheduled deletion only inside the grace period', async () => {
    const a = await newUser();
    expect((await call(a.id, 'POST', '/account/deletion/cancel')).status).toBe(409); // nothing scheduled
    await dbm.db.insert(dbm.profiles).values({ userId: a.id, deletedAt: new Date() }).onConflictDoUpdate({ target: dbm.profiles.userId, set: { deletedAt: new Date() } });
    const snap = (await call(a.id, 'GET', '/account/me')).json.data;
    expect(new Date(snap.deletionScheduledFor).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await call(a.id, 'POST', '/account/deletion/cancel')).status).toBe(200);
    expect((await call(a.id, 'GET', '/account/me')).json.data.deletionScheduledFor).toBeNull();
    await dbm.db.update(dbm.profiles).set({ deletedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(dbm.profiles.userId, a.id));
    expect((await call(a.id, 'POST', '/account/deletion/cancel')).status).toBe(403);
  });

  it('refuses to unlink the last sign-in method; unlinks when another exists', async () => {
    const a = await newUser();
    const last = await call(a.id, 'DELETE', '/account/identities/email');
    expect(last.status).toBe(422); // email can never be unlinked (the password would keep working)
    expect((await call(a.id, 'DELETE', '/account/identities/google')).status).toBe(404); // not linked
    expect((await call(a.id, 'DELETE', '/account/identities/github')).status).toBe(422);
    // simulate a linked Google identity (OAuth itself is client-side)
    await dbm.db.execute(sql`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values (${'g-' + a.id}, ${a.id}, ${JSON.stringify({ sub: a.id, email: 'g@test.local' })}::jsonb, 'google', now(), now(), now())`);
    // Google is the only provider left (email identity removed by hand): refuse, it is the last method
    await dbm.db.execute(sql`delete from auth.identities where user_id = ${a.id} and provider = 'email'`);
    const lastG = await call(a.id, 'DELETE', '/account/identities/google');
    expect([lastG.status, lastG.json.error?.message]).toEqual([409, 'last_login_method']);
    await dbm.db.execute(sql`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values (${'e-' + a.id}, ${a.id}, ${JSON.stringify({ sub: a.id, email: a.email })}::jsonb, 'email', now(), now(), now())`);
    const ok = await call(a.id, 'DELETE', '/account/identities/google');
    expect(ok.status).toBe(200);
    expect(ok.json.data.map((i: { provider: string }) => i.provider)).toEqual(['email']);
    expect((await call(a.id, 'GET', '/account/me')).json.data.identities).toHaveLength(1);
  });

  it('preferences: Free 15 is 403 pro_required, Free 10 ok, Pro 20 ok, and the queue honors the value', async () => {
    const free = await newUser();
    const f15 = await call(free.id, 'PATCH', '/account/preferences', { newCardsPerDay: 15 });
    expect(f15.status).toBe(403);
    expect(f15.json.error?.message).toBe('pro_required');
    expect((await call(free.id, 'PATCH', '/account/preferences', { newCardsPerDay: 7 })).status).toBe(422);
    expect((await call(free.id, 'PATCH', '/account/preferences', { newCardsPerDay: 5, theme: 'dark', reduceMotion: true })).json.data).toMatchObject({ newCardsPerDay: 5, theme: 'dark', reduceMotion: true });

    await seedCard(free.id, 12);
    const now = new Date();
    const q = async (u: string) => (await queue.getDailyQueue(u, { now })) as { ok: true; data: unknown[] };
    expect((await q(free.id)).data).toHaveLength(5); // chosen 5 < plan cap 10
    await call(free.id, 'PATCH', '/account/preferences', { newCardsPerDay: 10 });
    expect((await q(free.id)).data).toHaveLength(10);

    const pro = await newUser({ pro: true });
    expect((await call(pro.id, 'PATCH', '/account/preferences', { newCardsPerDay: 20 })).json.data.newCardsPerDay).toBe(20);
    await seedCard(pro.id, 25);
    expect((await q(pro.id)).data).toHaveLength(20);
    await call(pro.id, 'PATCH', '/account/preferences', { newCardsPerDay: 5 });
    expect((await q(pro.id)).data).toHaveLength(5);
    // D-647: null drops the personal cap; Pro has no plan cap
    expect((await call(pro.id, 'PATCH', '/account/preferences', { newCardsPerDay: null })).json.data.newCardsPerDay).toBeNull();
    expect((await q(pro.id)).data).toHaveLength(25);
    await call(pro.id, 'PATCH', '/account/preferences', { newCardsPerDay: 5 });
    // downgrade: a stored 20 no longer counts above the Free cap
    await dbm.db.update(dbm.subscriptions).set({ plan: 'free' }).where(eq(dbm.subscriptions.userId, pro.id));
    await dbm.db.update(dbm.userPreferences).set({ newCardsPerDay: 20 }).where(eq(dbm.userPreferences.userId, pro.id));
    expect((await q(pro.id)).data).toHaveLength(10);
  });

  describe('daily reminder (FR-15 → G18 notify review_reminder, D-781)', () => {
    const setup = async (o: { tz?: string; hour?: 7 | 8 | 12 | 20; due?: boolean } = {}) => {
      const u = await newUser({ tz: o.tz ?? 'America/Sao_Paulo' });
      await dbm.db.insert(dbm.userPreferences).values({ userId: u.id, reminderEnabled: true, reminderHour: o.hour ?? 20 });
      const [c] = await seedCard(u.id);
      if (o.due !== false) await dbm.db.insert(dbm.fsrsState).values({ userId: u.id, cardId: c!.id, due: new Date(at20brt.getTime() - 86_400_000), stability: 1, difficulty: 5, reps: 1, state: 'review', lastReview: new Date(at20brt.getTime() - 2 * 86_400_000), createdAt: new Date(at20brt.getTime() - 5 * 86_400_000) });
      return { ...u, card: c! };
    };
    // 23:00Z = 20:00 in America/Sao_Paulo (UTC-3) = 08:00 the next day in Tokyo (G18 D-744: hours 7/8/12/20).
    // A 2020 clock: the job scans every user, and only the ones made here have cards due by then.
    const at20brt = new Date('2020-06-10T23:00:00Z');
    const day = at20brt.toISOString().slice(0, 10);
    const calls: { userId: string; type: string; payload: { reference: string; data?: unknown; email?: unknown } }[] = [];
    const notify: Notify = async (userId, type, payload) => {
      calls.push({ userId, type, payload });
      return { inApp: 'created', notificationId: null, email: 'not_applicable', emailDeliveryId: null };
    };
    const mine = (id: string) => calls.filter((c) => c.userId === id);

    it('notifies at the local hour with the queue, once per local day', async () => {
      const u = await setup();
      await reminders.sendDailyReminders(at20brt, notify);
      expect(mine(u.id)).toHaveLength(1);
      expect(mine(u.id)[0]).toMatchObject({ type: 'review_reminder', payload: { reference: `${u.id}:${day}`, data: { cards: 1 }, email: { cards: 1, overdue: 1, maps: [{ title: 'b', cards: 1 }] } } });
      await reminders.sendDailyReminders(at20brt, notify);
      await reminders.sendDailyReminders(new Date(at20brt.getTime() + 15 * 60_000), notify); // the next */15 run, same hour
      expect(mine(u.id)).toHaveLength(1); // reminder_last_sent_on
      const [p] = await dbm.db.select().from(dbm.userPreferences).where(eq(dbm.userPreferences.userId, u.id));
      expect(p!.reminderLastSentOn).toBe(day);
    });

    it('skips: wrong hour, other timezone, both channels off, nothing due, already reviewed today, deleted', async () => {
      const wrongHour = await setup({ hour: 8 });
      const tokyo = await setup({ tz: 'Asia/Tokyo' }); // 08:00 there, not 20
      const off = await setup();
      await dbm.db.insert(dbm.notificationPreferences).values({ userId: off.id, key: 'review_reminder', inApp: false, email: false });
      const nothing = await setup({ due: false });
      const reviewed = await setup();
      await attempt(reviewed.id, reviewed.card.id, new Date(`${day}T15:00:00Z`)); // 12:00 BRT, same study day
      const deleted = await setup();
      await dbm.db.update(dbm.profiles).set({ deletedAt: new Date() }).where(eq(dbm.profiles.userId, deleted.id));
      const noMail = await setup(); // e-mail off still gets the bell: notify() decides the channels
      await dbm.db.insert(dbm.notificationPreferences).values({ userId: noMail.id, key: 'review_reminder', inApp: true, email: false });
      const control = await setup();
      await reminders.sendDailyReminders(at20brt, notify);
      for (const u of [wrongHour, tokyo, off, nothing, reviewed, deleted]) expect(mine(u.id)).toHaveLength(0);
      expect(mine(control.id)).toHaveLength(1);
      expect(mine(noMail.id)).toHaveLength(1);
      // the same instant is 08:00 in Tokyo: a Tokyo user with hour 7 got it an hour earlier
      const tokyo7 = await setup({ tz: 'Asia/Tokyo', hour: 7 });
      await reminders.sendDailyReminders(new Date(at20brt.getTime() - 3_600_000), notify);
      expect(mine(tokyo7.id)).toHaveLength(1);
    });

    it('unsubscribe turns the reminder off with one click; a forged token does nothing', async () => {
      const u = await setup();
      const token = reminders.unsubscribeToken(u.id);
      const bad = await app.request(`/v1/public/unsubscribe?token=${u.id}.${'A'.repeat(43)}`);
      expect(bad.status).toBe(422);
      expect((await app.request('/v1/public/unsubscribe?token=x')).status).toBe(422);
      const [still] = await dbm.db.select().from(dbm.userPreferences).where(eq(dbm.userPreferences.userId, u.id));
      expect(still!.reminderEnabled).toBe(true);
      const get = await app.request(`/v1/public/unsubscribe?token=${token}`); // link scanners GET: must not change state
      expect(get.status).toBe(200);
      expect(await get.text()).toContain('method="post"');
      expect((await dbm.db.select().from(dbm.userPreferences).where(eq(dbm.userPreferences.userId, u.id)))[0]!.reminderEnabled).toBe(true);
      expect((await app.request(`/v1/public/unsubscribe?token=x`, { method: 'POST' })).status).toBe(422);
      const res = await app.request(`/v1/public/unsubscribe?token=${token}`, { method: 'POST' }); // no Authorization header
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const [after] = await dbm.db.select().from(dbm.userPreferences).where(eq(dbm.userPreferences.userId, u.id));
      expect(after!.reminderEnabled).toBe(false);
      const [pref] = await dbm.db.select().from(dbm.notificationPreferences).where(eq(dbm.notificationPreferences.userId, u.id));
      expect(pref).toMatchObject({ key: 'review_reminder', email: false }); // notify() drops the e-mail, the bell stays
    });
  });
});
