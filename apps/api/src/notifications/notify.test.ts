// G18 F26 FR-7/FR-12: notify() decision (pure) and end to end on local Supabase with a fake e-mail provider.
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emailExamples } from '@remoa/contracts/mocks';
import type { EmailData, EmailTemplate } from '@remoa/contracts';
import { setEmailTestHooks, type OutgoingEmail } from '../emails/send';
import { verifyUnsubscribeToken } from '../emails/tokens';
import { emailHash } from '../referral/email-normalize';
import { emailDecision, notify, notifyAddress } from './notify';

config({ path: '../../.env' });

describe('emailDecision', () => {
  const on = { prefEmail: true, paused: false, hasAddress: true };
  it('preference off → disabled; no address or skipEmail → not applicable', () => {
    expect(emailDecision('map_ready', on)).toBe('send');
    expect(emailDecision('map_ready', { ...on, prefEmail: false })).toBe('disabled');
    expect(emailDecision('map_ready', { ...on, hasAddress: false })).toBe('not_applicable');
    expect(emailDecision('map_ready', { ...on, skipEmail: true })).toBe('not_applicable');
  });
  it('pause stops only pausable rows (reminders), never account, support or map ready', () => {
    for (const t of ['review_reminder', 'calendar_d1', 'calendar_d0', 'inactivity', 'onboarding_nudge'] as const) expect(emailDecision(t, { ...on, paused: true })).toBe('paused');
    expect(emailDecision('calendar_digest', { ...on, paused: true, window: 'd0' })).toBe('paused');
    for (const t of ['purchase', 'support_reply', 'map_ready', 'password_reset', 'account', 'referral_reward'] as const) expect(emailDecision(t, { ...on, paused: true })).toBe('send');
  });
});

const sample = <T extends EmailTemplate>(t: T, v?: string) => emailExamples.find((e) => e.template === t && (!v || e.version === v))!.data as EmailData<T>;
const calData = { eventId: randomUUID(), title: 'Prova', startsAt: new Date().toISOString(), allDay: false, location: null };

describe.skipIf(!process.env.DATABASE_URL)('notify (local Supabase, fake provider)', () => {
  let sent: OutgoingEmail[] = [];
  const users: string[] = [];
  let supa: ReturnType<typeof import('../account/auth-admin')['adminClient']>;
  let db: typeof import('@remoa/db')['db'];
  const ref = () => randomUUID();

  setEmailTestHooks({ transport: async (m) => (sent.push(m), { id: `fake-${randomUUID()}` }), sleep: async () => undefined });
  beforeAll(async () => {
    supa = (await import('../account/auth-admin')).adminClient();
    db = (await import('@remoa/db')).db;
  });
  afterEach(() => {
    sent = [];
  });
  afterAll(async () => {
    setEmailTestHooks({});
    for (const id of users) await supa.auth.admin.deleteUser(id);
  });
  const newUser = async () => {
    const { data, error } = await supa.auth.admin.createUser({ email: `g18n-${randomUUID()}@test.local`, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    return data.user.id;
  };
  const pref = (userId: string, key: string, inApp: boolean, email: boolean) =>
    db.execute(sql`insert into notification_preferences (user_id, key, in_app, email) values (${userId}, ${key}, ${inApp}, ${email}) on conflict (user_id, key) do update set in_app = excluded.in_app, email = excluded.email`);
  const pause = (userId: string) =>
    db.execute(sql`insert into user_preferences (user_id, notif_pause_reminders) values (${userId}, true) on conflict (user_id) do update set notif_pause_reminders = true`);
  const calendar = (userId: string, reference = ref()) =>
    notify(userId, 'calendar_d1', { reference, href: '/app/calendario', data: calData, email: sample('calendar-reminder', 'd1') });

  it('in-app row + e-mail; a repeat is a duplicate on both channels and sends nothing', async () => {
    const u = await newUser();
    const payload = { reference: ref(), href: '/app/mapas/x', data: { boardId: randomUUID(), title: 'Sepse', cards: 12 }, email: sample('map-ready') };
    const a = await notify(u, 'map_ready', payload);
    expect(a).toMatchObject({ inApp: 'created', email: 'queued' });
    const b = await notify(u, 'map_ready', payload);
    expect(b).toEqual({ ...a, inApp: 'duplicate', email: 'duplicate' });
    expect(sent).toHaveLength(1);
    const [n] = await db.execute<{ type: string; category: string; href: string; idempotency_key: string }>(sql`select * from notifications where id = ${a.notificationId}`);
    expect(n).toMatchObject({ type: 'map_ready', category: 'maps', href: '/app/mapas/x', idempotency_key: `map_ready:${payload.reference}` });
    const c = await notify(u, 'map_ready', { ...payload, reference: ref() }, { skipEmail: true });
    expect(c).toMatchObject({ inApp: 'created', email: 'not_applicable', emailDeliveryId: null });
  });

  it('preferences: app off → no row; e-mail off → no e-mail; review e-mail is off by default (D-743)', async () => {
    const u = await newUser();
    await pref(u, 'map_ready', false, false);
    expect(await notify(u, 'map_ready', { reference: ref(), data: { boardId: randomUUID(), title: 'x', cards: 1 }, email: sample('map-ready') })).toMatchObject({ inApp: 'disabled', email: 'disabled', notificationId: null });
    expect(await notify(u, 'review_reminder', { reference: ref(), data: { cards: 3 }, email: sample('review-reminder') })).toMatchObject({ inApp: 'created', email: 'disabled' });
    expect(sent).toHaveLength(0);
  });

  it('fixed rows: support e-mail goes even with the bell off; e-mail-only types never create a row', async () => {
    const u = await newUser();
    await pref(u, 'support', false, true);
    expect(await notify(u, 'support_reply', { reference: ref(), data: { ticketId: randomUUID(), ticketNumber: 7 }, email: sample('support-reply', 'answered') })).toMatchObject({ inApp: 'disabled', email: 'queued' });
    expect(await notify(u, 'password_changed', { reference: ref(), email: sample('password-changed') })).toMatchObject({ inApp: 'not_applicable', email: 'queued' });
    expect(sent.map((m) => m.subject)).toEqual(['Resposta ao chamado #128', 'Sua senha do Remoa foi alterada']);
  });

  it('pause stops reminder e-mails (bell still rings), not purchases', async () => {
    const u = await newUser();
    await pause(u);
    expect(await calendar(u)).toMatchObject({ inApp: 'created', email: 'paused' });
    expect(await notify(u, 'purchase', { reference: ref(), data: { planName: 'Remoa Pro', orderId: 'in_1' }, email: sample('purchase-success') })).toMatchObject({ email: 'queued' });
    expect(sent).toHaveLength(1);
  });

  it('cap: at most 2 reminder e-mails in 24 h; the third is in-app only; transactional mail is not counted', async () => {
    const u = await newUser();
    expect((await calendar(u)).email).toBe('queued');
    expect((await notify(u, 'purchase', { reference: ref(), data: { planName: 'Remoa Pro', orderId: 'in_2' }, email: sample('purchase-success') })).email).toBe('queued');
    expect((await calendar(u)).email).toBe('queued');
    const third = await calendar(u);
    expect(third).toMatchObject({ inApp: 'created', email: 'capped', emailDeliveryId: null });
    expect(sent).toHaveLength(3);
    // a capped send is not remembered as sent: the same reference may go out once the window frees up
    expect((await notify(u, 'calendar_d1', { reference: 'never', href: '/app/calendario', data: calData, email: sample('calendar-reminder', 'd1') }, { now: new Date(Date.now() + 25 * 3_600_000) })).email).toBe('queued');
  });

  it('cap is atomic: 4 parallel reminder e-mails → exactly 2 go out', async () => {
    const u = await newUser();
    const r = await Promise.all([calendar(u), calendar(u), calendar(u), calendar(u)]);
    expect(r.filter((x) => x.email === 'queued')).toHaveLength(2);
    expect(r.filter((x) => x.email === 'capped')).toHaveLength(2);
  });

  const scheduleCalendar = async (userId: string) => {
    const [l] = await db.execute<{ id: string }>(sql`insert into calendar_labels (user_id, name, color) values (${userId}, 'Prova', 'orange') returning id`);
    const startsAt = new Date(Date.now() + 30 * 3_600_000);
    const [e] = await db.execute<{ id: string }>(sql`insert into calendar_events (user_id, title, label_id, starts_at, timezone) values (${userId}, 'Prova', ${l!.id}, ${startsAt.toISOString()}, 'America/Sao_Paulo') returning id`);
    await db.execute(sql`insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at) values (${userId}, ${e!.id}, 'd1', ${startsAt.toISOString().slice(0, 10)}, ${new Date(Date.now() + 6 * 3_600_000).toISOString()})`);
  };
  const review = (userId: string) => notify(userId, 'review_reminder', { reference: ref(), data: { cards: 3 }, email: sample('review-reminder') });
  const inactivity = (userId: string) => notify(userId, 'inactivity', { reference: ref(), email: sample('inactivity') });

  it('priority: a calendar e-mail scheduled in the next 24 h keeps its slot; review/inactivity yield, calendar does not', async () => {
    const u = await newUser();
    await pref(u, 'review_reminder', true, true);
    await scheduleCalendar(u);
    expect((await review(u)).email).toBe('queued');
    expect((await inactivity(u)).email).toBe('capped'); // 1 sent + 1 reserved
    expect((await calendar(u)).email).toBe('queued'); // calendar ignores the reservation
  });

  it('priority: calendar reminders whose e-mail is switched off reserve nothing', async () => {
    const u = await newUser();
    await pref(u, 'review_reminder', true, true);
    await pref(u, 'calendar_d1', true, false);
    await scheduleCalendar(u);
    expect((await review(u)).email).toBe('queued');
    expect((await inactivity(u)).email).toBe('queued');
    expect((await inactivity(u)).email).toBe('capped');
  });

  it('no such user / bad reference: nothing happens, nothing throws', async () => {
    expect(await notify(randomUUID(), 'map_ready', { reference: ref(), data: { boardId: randomUUID(), title: 'x', cards: 1 }, email: sample('map-ready') })).toEqual({ inApp: 'not_applicable', notificationId: null, email: 'not_applicable', emailDeliveryId: null });
    const u = await newUser();
    expect((await notify(u, 'map_ready', { reference: 'a b', data: { boardId: randomUUID(), title: 'x', cards: 1 }, email: sample('map-ready') })).inApp).toBe('not_applicable');
  });

  it('notifyAddress: e-mail without an account, unsubscribe by address hash, idempotent', async () => {
    const to = `friend-${randomUUID()}@test.local`;
    const reference = emailHash(to);
    const a = await notifyAddress(to, 'referral_invite', { reference, email: sample('referral-invite') });
    expect(a.email).toBe('queued');
    expect((await notifyAddress(to, 'referral_invite', { reference, email: sample('referral-invite') })).email).toBe('duplicate');
    expect(sent).toHaveLength(1);
    const token = new URL(/<([^>]+)>/.exec(sent[0]!.headers!['List-Unsubscribe']!)![1]!).searchParams.get('token')!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({ subject: { emailHash: reference }, scope: 'referral_invite' });
    const [d] = await db.execute<{ user_id: string | null; reference: string }>(sql`select user_id, reference from email_deliveries where id = ${a.emailDeliveryId}`);
    expect(d).toEqual({ user_id: null, reference: `referral_invite:${reference}` });
  });
});
