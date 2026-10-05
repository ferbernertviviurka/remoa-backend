// Integration: needs local Supabase (see account.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationPrefsSchema } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/notifications', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (user: string | null, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1${path}`, { method, headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const insert = async (userId: string, i: number, over: Record<string, unknown> = {}) => {
    const [r] = await dbm.db.insert(dbm.notifications).values({
      userId, type: 'review_reminder', category: 'review', data: { cards: i + 1 }, idempotencyKey: `review_reminder:${userId}:${i}`, href: '/app/revisar',
      createdAt: new Date(Date.now() - i * 1000), ...over,
    }).returning();
    return r!;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('requires auth', async () => {
    expect((await call(null, 'GET', '/notifications')).status).toBe(401);
    expect((await call(null, 'GET', '/notifications/prefs')).status).toBe(401);
  });

  it('lists newest first with a stable cursor, hides dismissed and expired, filters unread and category', async () => {
    const a = await newUser();
    const rows = await Promise.all([0, 1, 2, 3, 4].map((i) => insert(a, i)));
    await insert(a, 5, { dismissedAt: new Date() });
    await insert(a, 6, { expiresAt: new Date(Date.now() - 1000) });
    await insert(a, 7, { type: 'purchase', category: 'account_billing', data: { planName: 'Pro', orderId: 'x' }, href: null, readAt: new Date() });
    const p1 = await call(a, 'GET', '/notifications?limit=3');
    expect(p1.status).toBe(200);
    expect(p1.json.data.items.map((n: { id: string }) => n.id)).toEqual(rows.slice(0, 3).map((r) => r.id));
    expect(p1.json.data.nextCursor).toBeTruthy();
    const p2 = await call(a, 'GET', `/notifications?limit=3&cursor=${p1.json.data.nextCursor}`);
    expect(p2.json.data.items.map((n: { id: string }) => n.id)).toEqual([...rows.slice(3).map((r) => r.id), expect.any(String)]);
    expect(p2.json.data.nextCursor).toBeNull();
    expect((await call(a, 'GET', '/notifications?filter=unread&limit=50')).json.data.items).toHaveLength(5);
    expect((await call(a, 'GET', '/notifications?category=account_billing')).json.data.items).toHaveLength(1);
    expect((await call(a, 'GET', '/notifications?category=nope')).status).toBe(422);
    expect((await call(a, 'GET', '/notifications?cursor=garbage')).status).toBe(422);
  });

  it('unread-count by category, read by ids or all, dismiss; another user sees and changes nothing', async () => {
    const a = await newUser();
    const b = await newUser();
    const n1 = await insert(a, 0);
    await insert(a, 1);
    await insert(a, 2, { type: 'map_ready', category: 'maps', data: { boardId: uuid(), title: 'x', cards: 3 }, href: null });
    const mine = await insert(b, 0);
    expect((await call(a, 'GET', '/notifications/unread-count')).json.data).toMatchObject({ total: 3, byCategory: { review: 2, maps: 1, calendar: 0 } });
    // b cannot read, dismiss or mark a's
    expect((await call(b, 'POST', '/notifications/read', { ids: [n1.id] })).json.data).toEqual({ updated: 0, unread: 1 });
    expect((await call(b, 'DELETE', `/notifications/${n1.id}`)).status).toBe(404);
    expect((await call(b, 'GET', '/notifications')).json.data.items.map((n: { id: string }) => n.id)).toEqual([mine.id]);
    expect((await call(a, 'GET', '/notifications/unread-count')).json.data.total).toBe(3);
    expect((await call(a, 'POST', '/notifications/read', { ids: [n1.id] })).json.data).toEqual({ updated: 1, unread: 2 });
    expect((await call(a, 'POST', '/notifications/read', { ids: [] })).status).toBe(422);
    expect((await call(a, 'DELETE', `/notifications/${n1.id}`)).status).toBe(200);
    expect((await call(a, 'DELETE', `/notifications/${n1.id}`)).status).toBe(200); // idempotent
    expect((await call(a, 'DELETE', '/notifications/not-a-uuid')).status).toBe(404);
    expect((await call(a, 'POST', '/notifications/read', { all: true })).json.data).toEqual({ updated: 2, unread: 0 });
    expect((await call(a, 'GET', '/notifications')).json.data.items).toHaveLength(2);
  });

  it('prefs: defaults, patch a cell, refuse fixed/absent channels, pause, reminder time; old F13 preferences share the source (P-301)', async () => {
    const a = await newUser();
    const d = await call(a, 'GET', '/notifications/prefs');
    const prefs = notificationPrefsSchema.parse(d.json.data);
    expect(prefs.matrix.review_reminder).toEqual({ inApp: true, email: false });
    expect(prefs.matrix.support).toEqual({ inApp: true, email: true });
    expect(prefs.matrix.inactivity).toEqual({ inApp: false, email: true });
    expect(prefs).toMatchObject({ pauseReminders: false, reviewReminderTime: '20:00' });

    const p = await call(a, 'PATCH', '/notifications/prefs', { pref: { key: 'calendar_d1', channel: 'email', value: false } });
    expect(p.json.data.matrix.calendar_d1).toEqual({ inApp: true, email: false });
    expect((await call(a, 'PATCH', '/notifications/prefs', { pref: { key: 'support', channel: 'email', value: false } })).status).toBe(422);
    expect((await call(a, 'PATCH', '/notifications/prefs', { pref: { key: 'inactivity', channel: 'inApp', value: true } })).status).toBe(422);
    expect((await call(a, 'PATCH', '/notifications/prefs', {})).status).toBe(422);
    const q = await call(a, 'PATCH', '/notifications/prefs', { pauseReminders: true, reviewReminderTime: '07:00' });
    expect(q.json.data).toMatchObject({ pauseReminders: true, reviewReminderTime: '07:00' });
    expect((await call(a, 'PATCH', '/notifications/prefs', { reviewReminderTime: '09:00' })).status).toBe(422);

    // F13 route reads and writes the same source
    await call(a, 'PATCH', '/notifications/prefs', { pref: { key: 'review_reminder', channel: 'email', value: true } });
    const f13 = await call(a, 'PATCH', '/account/preferences', { theme: 'dark' });
    expect(f13.json.data).toMatchObject({ reminderEnabled: true, emailReviewReminders: true, reminderHour: 7, theme: 'dark' });
    const off = await call(a, 'PATCH', '/account/preferences', { reminderEnabled: false });
    expect(off.json.data).toMatchObject({ reminderEnabled: false, emailReviewReminders: false });
    expect((await call(a, 'GET', '/notifications/prefs')).json.data.matrix.review_reminder).toEqual({ inApp: true, email: false });
    await call(a, 'PATCH', '/account/preferences', { emailReviewReminders: true });
    expect((await call(a, 'GET', '/notifications/prefs')).json.data.matrix.review_reminder.email).toBe(true);
    // the other user is untouched
    const b = await newUser();
    expect((await call(b, 'GET', '/notifications/prefs')).json.data.matrix.review_reminder.email).toBe(false);
  });
});
