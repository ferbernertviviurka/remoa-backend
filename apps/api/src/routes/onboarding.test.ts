// Integration: needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onboardingStateSchema } from '@remoa/contracts';
import { templateOf } from '../test-email';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/onboarding', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let sent: Awaited<ReturnType<typeof import('../test-email')['captureEmails']>>;
  let emails: typeof import('../onboarding/emails');

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = (u: string, path: string, body?: unknown) =>
    app.request(`/v1/onboarding${path}`, { method: body === undefined && path === '' ? 'GET' : 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mails = (u: string) => sent.filter((m) => m.to === `${u}@test.local`);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    sent = (await import('../test-email')).captureEmails();
    emails = await import('../onboarding/emails');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((x) => `'${x}'`).join(',')})`));
  });

  it('requires auth', async () => {
    expect((await app.request('/v1/onboarding')).status).toBe(401);
  });

  it('answers merge, write goal/stage, send the welcome once, hide _emails; complete is idempotent', async () => {
    const u = await newUser();
    const s0 = onboardingStateSchema.parse((await (await call(u, '')).json()).data);
    expect(s0).toMatchObject({ doneAt: null, answers: {} });
    expect(s0.checklist.map((i) => [i.id, i.current, i.target, i.done])).toEqual([['cards', 0, 20, false], ['edges', 0, 5, false], ['sessions', 0, 1, false]]);

    await call(u, '/answers', { goal: 'enamed_2027_1', segment: 'y5_6' });
    const r = await call(u, '/answers', { area: 'CM' });
    const s = onboardingStateSchema.parse((await r.json()).data);
    expect(s.answers).toEqual({ goal: 'enamed_2027_1', segment: 'y5_6', area: 'CM' });
    const [p] = await dbm.db.select().from(dbm.profiles).where(eq(dbm.profiles.userId, u));
    expect([p!.goal, p!.stage]).toEqual(['enamed_2027_1', 'y5_6']);
    expect(mails(u).filter((m) => templateOf(m) === 'welcome')).toHaveLength(1);

    expect((await call(u, '/answers', {})).status).toBe(422);
    expect((await call(u, '/answers', { startPath: 'zip' })).status).toBe(422);

    const c1 = (await (await call(u, '/complete', {})).json()).data;
    const c2 = (await (await call(u, '/complete', {})).json()).data;
    expect(c1.doneAt).not.toBeNull();
    expect(c2.doneAt).toBe(c1.doneAt);
  });

  it('G20: segment not_med is accepted and becomes stage', async () => {
    const u = await newUser();
    expect((await call(u, '/answers', { segment: 'not_med' })).status).toBe(200);
    const [p] = await dbm.db.select().from(dbm.profiles).where(eq(dbm.profiles.userId, u));
    expect(p!.stage).toBe('not_med');
  });

  it('checklist counts live non-note cards, edges and ended sessions on non-archived boards, per user', async () => {
    const u = await newUser();
    const other = await newUser();
    const [b] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'A' }).returning();
    const [arch] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'B', archivedAt: new Date() }).returning();
    const [ob] = await dbm.db.insert(dbm.boards).values({ userId: other, title: 'C' }).returning();
    const mk = (boardId: string, n: number, extra: Partial<typeof dbm.cards.$inferInsert> = {}) =>
      Array.from({ length: n }, (_, i) => ({ id: uuid(), boardId, type: 'concept' as const, title: `c${i}`, order: i, ...extra }));
    const live = mk(b!.id, 20);
    await dbm.db.insert(dbm.cards).values([...live, ...mk(b!.id, 3, { type: 'note' }), ...mk(b!.id, 2, { deletedAt: new Date() }), ...mk(arch!.id, 5), ...mk(ob!.id, 9)]);
    await dbm.db.insert(dbm.edges).values([{ boardId: b!.id, fromCardId: live[0]!.id, toCardId: live[1]!.id }, { boardId: b!.id, fromCardId: live[1]!.id, toCardId: live[2]!.id }]);
    await dbm.db.insert(dbm.sessions).values([{ userId: u, boardId: b!.id, kind: 'board', endedAt: new Date() }, { userId: u, boardId: b!.id, kind: 'board' }]);
    const s = onboardingStateSchema.parse((await (await call(u, '')).json()).data);
    expect(s.checklist).toEqual([
      { id: 'cards', current: 20, target: 20, done: true },
      { id: 'edges', current: 2, target: 5, done: false },
      { id: 'sessions', current: 1, target: 1, done: true },
    ]);

    // mapReady: sent once by the sweep
    const now = new Date();
    await emails.sendOnboardingEmails(now);
    await emails.sendOnboardingEmails(now);
    expect(mails(u).filter((m) => templateOf(m) === 'onboarding-nudge' && m.text.includes('/app/revisar'))).toHaveLength(1);
    expect(mails(other)).toHaveLength(0);
  });

  it('day-3 nudge: only 3+ days old without a session, once', async () => {
    const old = await newUser();
    const fresh = await newUser();
    const active = await newUser();
    await dbm.db.update(dbm.profiles).set({ createdAt: new Date(Date.now() - 4 * 86_400_000) }).where(eq(dbm.profiles.userId, old));
    await dbm.db.update(dbm.profiles).set({ createdAt: new Date(Date.now() - 4 * 86_400_000) }).where(eq(dbm.profiles.userId, active));
    await dbm.db.insert(dbm.sessions).values({ userId: active, kind: 'board', endedAt: new Date() });
    await emails.sendOnboardingEmails(new Date());
    await emails.sendOnboardingEmails(new Date());
    const nudge = (x: string) => mails(x).filter((m) => templateOf(m) === 'onboarding-nudge');
    expect(nudge(old)).toHaveLength(1);
    expect(nudge(fresh)).toHaveLength(0);
    expect(nudge(active)).toHaveLength(0);
  });
});
