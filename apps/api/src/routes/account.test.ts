// Integration: needs local Supabase (see matrix.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountExportSchema } from '@remoa/contracts';

config({ path: '../../.env' });

const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('/v1/account (export, delete) + maintenance jobs', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let jobs: typeof import('../account/jobs');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (user: string, method: string, path: string) => {
    const res = await app.request(`/v1${path}`, { method, headers: { authorization: `Bearer ${user}` } });
    return { status: res.status, res, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const seedData = async (u: string, answer = 'minha resposta') => {
    const [board] = await dbm.db.insert(dbm.boards).values({ userId: u, title: 'b' }).returning();
    const [a, b] = await dbm.db.insert(dbm.cards).values([{ boardId: board!.id, title: 'a' }, { boardId: board!.id, title: 'b' }]).returning();
    await dbm.db.insert(dbm.edges).values({ boardId: board!.id, fromCardId: a!.id, toCardId: b!.id });
    const [att] = await dbm.db.insert(dbm.attempts).values({ userId: u, cardId: a!.id, mode: 'hidden_card', inputKind: 'text', answerText: answer, grade: 3 }).returning();
    return { board: board!, att: att! };
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    jobs = await import('../account/jobs');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('export returns only own rows, parses, and downloads as a file; requires auth', async () => {
    const a = await newUser();
    const b = await newUser();
    const mine = await seedData(a);
    await seedData(b);
    const [t] = await dbm.db.insert(dbm.supportTickets).values({ userId: a, type: 'bug', subject: 'Erro no mapa' }).returning();
    await dbm.db.insert(dbm.supportMessages).values([{ ticketId: t!.id, authorType: 'user', authorId: a, body: 'oi' }, { ticketId: t!.id, authorType: 'admin', body: 'nota interna', internal: true }]);
    const r = await call(a, 'POST', '/account/export');
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-disposition')).toMatch(/^attachment; filename="remoa-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = accountExportSchema.parse(r.json.data);
    expect(data.userId).toBe(a);
    expect(data.boards.map((x) => x.id)).toEqual([mine.board.id]);
    expect(data.cards).toHaveLength(2);
    expect(data.edges).toHaveLength(1);
    expect(data.attempts.map((x) => x.id)).toEqual([mine.att.id]);
    expect(data.tickets.map((x) => [x.id, x.messages.map((m) => m.body)])).toEqual([[t!.id, ['oi']]]); // F19 FR-9: no internal notes, no assignee
    expect((await app.request('/v1/account/export', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/account', { method: 'DELETE' })).status).toBe(401);
  });

  it('delete soft-deletes (profile upserted), returns +7d, then every route answers 403 account_deleted', async () => {
    const u = await newUser();
    const before = Date.now();
    const r = await call(u, 'DELETE', '/account');
    expect(r.status).toBe(200);
    expect(new Date(r.json.data.hardDeleteAt).getTime() - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
    const [p] = await dbm.db.select().from(dbm.profiles).where(eq(dbm.profiles.userId, u));
    expect(p!.deletedAt).not.toBeNull();
    for (const [m, path] of [['GET', '/boards'], ['GET', '/me'], ['DELETE', '/account']] as const) { // export passes during the grace period (D-123)
      const x = await call(u, m, path);
      expect(x.status).toBe(403);
      expect(x.json.error).toEqual({ code: 'forbidden', message: 'account_deleted' });
    }
  });

  it('delete cancels a live Stripe subscription first; if Stripe fails the account stays live', async () => {
    const { createApp } = await import('../app');
    const canceled: string[] = [];
    let failing = true;
    const stripe = {
      createCustomer: async () => 'cus', checkout: async () => '', portal: async () => '', subscription: async () => { throw new Error('unused'); },
      cancelNow: async (id: string) => { if (failing) throw new Error('stripe down'); canceled.push(id); },
    };
    const withStripe = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null), stripe });
    const u = await newUser();
    await dbm.db.insert(dbm.subscriptions).values({ userId: u, plan: 'pro', status: 'active', stripeSubscriptionId: `sub_${u}` });
    const del = () => withStripe.request('/v1/account', { method: 'DELETE', headers: { authorization: `Bearer ${u}` } });
    expect((await del()).status).toBe(500);
    expect((await call(u, 'GET', '/me')).status).toBe(200);
    failing = false;
    expect((await del()).status).toBe(200);
    expect(canceled).toEqual([`sub_${u}`]);
    expect((await call(u, 'GET', '/me')).status).toBe(403);
  });

  it('purge removes users soft-deleted over 7 days ago and cascades; not before', async () => {
    const old = await newUser();
    const recent = await newUser();
    const live = await newUser();
    const { board } = await seedData(old);
    await seedData(recent);
    const now = new Date();
    // profiles rows are auto-created with the auth user
    await dbm.db.update(dbm.profiles).set({ deletedAt: new Date(now.getTime() - 7 * DAY - 1000) }).where(eq(dbm.profiles.userId, old));
    await dbm.db.update(dbm.profiles).set({ deletedAt: new Date(now.getTime() - 6 * DAY) }).where(eq(dbm.profiles.userId, recent));
    const exists = async (id: string) => (await dbm.db.execute(sql`select 1 from auth.users where id = ${id}`)).length > 0;
    await jobs.purgeDeletedAccounts(now);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(await dbm.db.select().from(dbm.boards).where(eq(dbm.boards.id, board.id))).toHaveLength(0);
    expect(await dbm.db.select().from(dbm.cards).where(eq(dbm.cards.boardId, board.id))).toHaveLength(0);
    expect(await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, old))).toHaveLength(0);
    expect(await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.userId, recent))).toHaveLength(1);
  });

  it('purge skips (and retries later) a user whose live subscription cannot be canceled; cancels it when Stripe is available', async () => {
    const u = await newUser();
    await dbm.db.update(dbm.profiles).set({ deletedAt: new Date(Date.now() - 8 * DAY) }).where(eq(dbm.profiles.userId, u));
    await dbm.db.insert(dbm.subscriptions).values({ userId: u, plan: 'pro', status: 'active', stripeSubscriptionId: `sub_${u}` });
    const exists = async () => (await dbm.db.execute(sql`select 1 from auth.users where id = ${u}`)).length > 0;
    await jobs.purgeDeletedAccounts(new Date());
    expect(await exists()).toBe(true);
    const canceled: string[] = [];
    const stripe = { createCustomer: async () => '', checkout: async () => '', portal: async () => '', subscription: async () => { throw new Error('unused'); }, cancelNow: async (id: string) => { canceled.push(id); } };
    await jobs.purgeDeletedAccounts(new Date(), stripe);
    expect(canceled).toEqual([`sub_${u}`]);
    expect(await exists()).toBe(false);
  });

  it('answer_text expires after 180 days only; the attempt row stays', async () => {
    const u = await newUser();
    const { att: oldAtt } = await seedData(u, 'velha');
    const { att: newAtt } = await seedData(u, 'nova');
    const now = new Date();
    await dbm.db.update(dbm.attempts).set({ createdAt: new Date(now.getTime() - 181 * DAY) }).where(eq(dbm.attempts.id, oldAtt.id));
    await dbm.db.update(dbm.attempts).set({ createdAt: new Date(now.getTime() - 179 * DAY) }).where(eq(dbm.attempts.id, newAtt.id));
    expect(await jobs.expireAnswerTexts(now)).toBeGreaterThanOrEqual(1);
    const get = async (id: string) => (await dbm.db.select().from(dbm.attempts).where(eq(dbm.attempts.id, id)))[0]!;
    expect((await get(oldAtt.id)).answerText).toBeNull();
    expect((await get(newAtt.id)).answerText).toBe('nova');
  });
});
