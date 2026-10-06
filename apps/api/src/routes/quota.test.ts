// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });

const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('F08 entitlements + quota', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let ent: typeof import('../billing/entitlements');
  let q: typeof import('../billing/quota');
  let app: ReturnType<typeof import('../app').createApp>;
  const tokens: Record<string, string> = {};

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    tokens[id] = id;
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const sub = (userId: string, v: Partial<typeof dbm.subscriptions.$inferInsert>) => dbm.db.insert(dbm.subscriptions).values({ userId, plan: 'pro', status: 'active', ...v });
  const plan = async (u: string, now = new Date()) => (await ent.getEntitlements(u, now) as { ok: true; data: import('@remoa/contracts').Entitlements }).data;
  const call = async (u: string, path: string, body: unknown) => {
    const res = await app.request(`/v1/boards${path}`, { method: 'POST', headers: { authorization: `Bearer ${u}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { data?: { id: string }; error?: { code: string; message: string } } };
  };
  const board = (u: string) => call(u, '', { title: 'Mapa' });
  const bulkCards = async (boardId: string, n: number) => dbm.db.insert(dbm.cards).values(Array.from({ length: n }, (_, i) => ({ boardId, title: `c${i}` })));
  const createCardOp = (boardId: string) => ({ op: 'createCard', opId: uuid(), boardId, card: { id: uuid(), type: 'concept', title: 'x', position: { x: 0, y: 0 } } });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    ent = await import('../billing/entitlements');
    q = await import('../billing/quota');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => tokens[t] ?? null });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((i) => `'${i}'`).join(',')})`));
  });

  describe('entitlements', () => {
    it('no subscription row -> free with free limits and zero usage', async () => {
      const e = await plan(await newUser());
      expect(e).toMatchObject({ plan: 'free', status: null, newCardsPerDay: 10, ankiImportMaxCards: 200, ankiImports: 1, ankiImportsUsed: 0, graceUntil: null, usage: { ai_grades: 0, ai_generations: 0, boards: 0, cards: 0 } });
      expect(e.limits).toEqual({ ai_grades: 20, ai_generations: 0, boards: 2, cards: 50 });
    });

    it('pro active / trialing -> pro; free plan row stays free', async () => {
      const [a, t, f] = [await newUser(), await newUser(), await newUser()];
      await sub(a, {});
      await sub(t, { status: 'trialing' });
      await sub(f, { plan: 'free' });
      expect(await plan(a)).toMatchObject({ plan: 'pro', newCardsPerDay: null, ankiImportMaxCards: null, ankiImports: null, limits: { ai_grades: 50, ai_generations: 5, boards: null, cards: null } });
      expect((await plan(t)).plan).toBe('pro');
      expect((await plan(f)).plan).toBe('free');
    });

    it('past_due: pro inside the 7-day grace (graceUntil set), free after', async () => {
      const u = await newUser();
      const renews = new Date(Date.now() - 3 * DAY);
      await sub(u, { status: 'past_due', renewsAt: renews });
      expect(await plan(u)).toMatchObject({ plan: 'pro', graceUntil: new Date(renews.getTime() + 7 * DAY) });
      expect(await plan(u, new Date(renews.getTime() + 7 * DAY + 1000))).toMatchObject({ plan: 'free', graceUntil: null });
    });

    it('canceled at period end: pro until renewsAt, free after; canceled without the flag is free', async () => {
      const [u, w] = [await newUser(), await newUser()];
      const renews = new Date(Date.now() + 10 * DAY);
      await sub(u, { status: 'canceled', cancelAtPeriodEnd: true, renewsAt: renews });
      await sub(w, { status: 'canceled', renewsAt: renews });
      expect(await plan(u)).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: true });
      expect((await plan(u, new Date(renews.getTime() + 1000))).plan).toBe('free');
      expect((await plan(w)).plan).toBe('free');
    });

    it('pix (no Stripe subscription): pro until renewsAt, free after, even with status active', async () => {
      const u = await newUser();
      const renews = new Date(Date.now() + 10 * DAY);
      await sub(u, { renewsAt: renews, cancelAtPeriodEnd: true });
      expect((await plan(u)).plan).toBe('pro');
      expect((await plan(u, new Date(renews.getTime() + 1000))).plan).toBe('free');
    });

    it('subscription deleted -> free again', async () => {
      const u = await newUser();
      await sub(u, {});
      expect((await plan(u)).plan).toBe('pro');
      await dbm.db.delete(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u));
      expect((await plan(u)).plan).toBe('free');
    });

    it('usage: today grades, month generations, live boards (not archived) and live cards', async () => {
      const u = await newUser();
      const day = await q.localDay(u, new Date());
      const first = `${day.slice(0, 8)}01`;
      await dbm.db.insert(dbm.usageCounters).values([{ userId: u, period: day, aiGrades: 4 }, { userId: u, period: first, aiGenerations: 1 }]);
      const b = (await board(u)).json.data!.id;
      const arch = (await board(u)).json.data!.id;
      await dbm.db.execute(sql`update boards set archived_at = now() where id = ${arch}`);
      await bulkCards(b, 3);
      await dbm.db.execute(sql`update cards set deleted_at = now() where board_id = ${b} and title = 'c0'`);
      expect((await plan(u)).usage).toEqual({ ai_grades: 4, ai_generations: 1, boards: 1, cards: 2 });
    });
  });

  describe('assertQuota', () => {
    it('ai_grades: free 20/day, pro 50/day (51st blocked), founder unlimited but still counts', async () => {
      const [f, p, fo] = [await newUser(), await newUser(), await newUser()];
      await sub(p, {});
      await sub(fo, { plan: 'founder' });
      for (let i = 0; i < 20; i++) expect((await q.assertQuota(f, 'ai_grades')).ok).toBe(true);
      expect(await q.assertQuota(f, 'ai_grades')).toEqual({ ok: false, error: { code: 'quota_exceeded', message: 'ai_grades' } });
      for (let i = 0; i < 50; i++) expect((await q.assertQuota(p, 'ai_grades')).ok).toBe(true);
      expect(await q.assertQuota(p, 'ai_grades')).toEqual({ ok: false, error: { code: 'quota_exceeded', message: 'ai_grades' } });
      for (let i = 0; i < 60; i++) expect((await q.assertQuota(fo, 'ai_grades')).ok).toBe(true);
      expect((await plan(fo)).usage.ai_grades).toBe(60);
    });

    it('ai_generations (D-647): free 0 (blocked, nothing counted), pro 5 per month (6th blocked), founder unlimited', async () => {
      const [f, p, fo] = [await newUser(), await newUser(), await newUser()];
      await sub(p, {});
      await sub(fo, { plan: 'founder' });
      expect(await q.assertQuota(f, 'ai_generations')).toEqual({ ok: false, error: { code: 'quota_exceeded', message: 'ai_generations' } });
      expect((await plan(f)).usage.ai_generations).toBe(0);
      for (let i = 0; i < 5; i++) expect((await q.assertQuota(p, 'ai_generations')).ok).toBe(true);
      expect((await q.assertQuota(p, 'ai_generations')).ok).toBe(false);
      for (let i = 0; i < 10; i++) expect((await q.assertQuota(fo, 'ai_generations')).ok).toBe(true);
      expect(await plan(fo)).toMatchObject({ plan: 'founder', newCardsPerDay: null, ankiImportMaxCards: null, ankiImports: null, limits: { ai_grades: null, ai_generations: null, boards: null, cards: null } });
    });

    it('atomic: 30 parallel calls on a free user grant exactly 20', async () => {
      const u = await newUser();
      const r = await Promise.all(Array.from({ length: 30 }, () => q.assertQuota(u, 'ai_grades')));
      expect(r.filter((x) => x.ok)).toHaveLength(20);
      expect((await plan(u)).usage.ai_grades).toBe(20);
    });

    it('reserveAi: refund gives the unit back once (G22)', async () => {
      const u = await newUser();
      const r = await q.reserveAi(u, 'ai_grades');
      if (!r.ok) throw new Error('reserve');
      await r.refund();
      await r.refund();
      expect((await plan(u)).usage.ai_grades).toBe(0);
    });

    it('boards / cards: check only, never consume', async () => {
      const u = await newUser();
      expect((await q.assertQuota(u, 'boards')).ok).toBe(true);
      expect((await q.assertQuota(u, 'boards')).ok).toBe(true);
      const b = (await board(u)).json.data!.id;
      await bulkCards(b, 49);
      expect((await q.assertQuota(u, 'cards')).ok).toBe(true);
      await bulkCards(b, 1);
      expect(await q.assertQuota(u, 'cards')).toEqual({ ok: false, error: { code: 'quota_exceeded', message: 'cards' } });
    });
  });

  describe('enforcement', () => {
    it('create board: 3rd is 402 "boards" for free; pro is unlimited; archiving frees a slot', async () => {
      const [f, p] = [await newUser(), await newUser()];
      await sub(p, {});
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) ids.push((await board(f)).json.data!.id);
      const over = await board(f);
      expect(over.status).toBe(402);
      expect(over.json.error).toEqual({ code: 'quota_exceeded', message: 'boards' });
      expect((await call(f, `/${ids[0]}/duplicate`, { title: 'Copia' })).status).toBe(402);
      for (let i = 0; i < 5; i++) expect((await board(p)).status).toBe(201);
    });

    it('FR-22 legacy free account with 3 live boards: reads, edits and ops still work; create/duplicate are 402 "boards"', async () => {
      const f = await newUser();
      const rows = await dbm.db.insert(dbm.boards).values([1, 2, 3].map((i) => ({ userId: f, title: `Legado ${i}` }))).returning();
      const e = await plan(f);
      expect(e.usage.boards).toBe(3);
      expect(e.limits.boards).toBe(2);
      const auth = { authorization: `Bearer ${f}`, 'content-type': 'application/json' };
      for (const [i, b] of rows.entries()) {
        expect((await app.request(`/v1/boards/${b.id}`, { headers: auth })).status).toBe(200);
        const patch = await app.request(`/v1/boards/${b.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: `Novo ${i}` }) });
        expect(patch.status).toBe(200);
        expect((await call(f, '/ops', { ops: [createCardOp(b.id)] })).status).toBe(200);
      }
      for (const r of [await board(f), await call(f, `/${rows[0]!.id}/duplicate`, { title: 'Copia' })]) {
        expect(r.status).toBe(402);
        expect(r.json.error).toEqual({ code: 'quota_exceeded', message: 'boards' });
      }
    });

    it('unarchive counts as a new live board: archive -> create -> unarchive cannot exceed the limit', async () => {
      const f = await newUser();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) ids.push((await board(f)).json.data!.id);
      const patch = (id: string, archived: boolean) => app.request(`/v1/boards/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${f}`, 'content-type': 'application/json' }, body: JSON.stringify({ archived }) });
      expect((await patch(ids[0]!, true)).status).toBe(200);
      expect((await board(f)).status).toBe(201);
      expect((await patch(ids[0]!, false)).status).toBe(402);
      expect((await patch(ids[1]!, false)).status).toBe(200); // already live: not a new board
    });

    it('createCard op: 50th card ok, 51st is 402 "cards" and nothing is applied; replay of a live card is not a new card; pro unlimited', async () => {
      const [f, p] = [await newUser(), await newUser()];
      await sub(p, {});
      const b = (await board(f)).json.data!.id;
      await bulkCards(b, 49);
      const ok1 = createCardOp(b);
      expect((await call(f, '/ops', { ops: [ok1] })).status).toBe(200);
      expect((await call(f, '/ops', { ops: [ok1] })).status).toBe(200); // replay, same id
      const over = await call(f, '/ops', { ops: [createCardOp(b)] });
      expect(over.status).toBe(402);
      expect(over.json.error).toEqual({ code: 'quota_exceeded', message: 'cards' });
      expect((await plan(f)).usage.cards).toBe(50);
      const pb = (await board(p)).json.data!.id;
      await bulkCards(pb, 50);
      expect((await call(p, '/ops', { ops: [createCardOp(pb)] })).status).toBe(200);
    });

    it('D-167: cards of archived maps do not count; unarchiving is a boards matter, but the next card then hits the cards cap', async () => {
      const f = await newUser();
      const a = (await board(f)).json.data!.id;
      const live = (await board(f)).json.data!.id;
      await bulkCards(a, 50);
      const patch = (id: string, archived: boolean) => app.request(`/v1/boards/${id}`, { method: 'PATCH', headers: { authorization: `Bearer ${f}`, 'content-type': 'application/json' }, body: JSON.stringify({ archived }) });
      expect((await patch(a, true)).status).toBe(200);
      expect((await plan(f)).usage.cards).toBe(0);
      expect((await call(f, '/ops', { ops: [createCardOp(live)] })).status).toBe(200);
      expect((await patch(a, true)).status).toBe(200);
      expect((await patch(live, true)).status).toBe(200);
      expect((await patch(a, false)).status).toBe(200);
      expect((await plan(f)).usage.cards).toBe(50);
      const over = await call(f, '/ops', { ops: [createCardOp(a)] });
      expect(over.status).toBe(402);
      expect(over.json.error?.message).toBe('cards');
    });

    it('legacy free account with 120 live cards keeps reading/editing; only creation blocks', async () => {
      const f = await newUser();
      const b = (await board(f)).json.data!.id;
      await bulkCards(b, 120);
      const auth = { authorization: `Bearer ${f}`, 'content-type': 'application/json' };
      expect((await app.request(`/v1/boards/${b}`, { headers: auth })).status).toBe(200);
      expect((await app.request(`/v1/boards/${b}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'Editado' }) })).status).toBe(200);
      expect((await plan(f)).usage.cards).toBe(120);
      expect((await call(f, '/ops', { ops: [createCardOp(b)] })).status).toBe(402);
    });

    it('duplicate board is blocked when the copy would exceed the card limit, with no half-created board', async () => {
      const u = await newUser();
      const b = (await board(u)).json.data!.id;
      await bulkCards(b, 30);
      const r = await call(u, `/${b}/duplicate`, { title: 'Copia' });
      expect(r.status).toBe(402);
      expect(r.json.error?.message).toBe('cards');
      expect((await plan(u)).usage.boards).toBe(1);
    });

    it('downgrade never deletes: a user above the limit keeps everything, only creation is blocked', async () => {
      const u = await newUser();
      await sub(u, {});
      const bs = [(await board(u)).json.data!.id];
      for (let i = 0; i < 4; i++) bs.push((await board(u)).json.data!.id);
      await bulkCards(bs[0]!, 250);
      await dbm.db.delete(dbm.subscriptions).where(eq(dbm.subscriptions.userId, u));
      expect((await plan(u)).usage).toMatchObject({ boards: 5, cards: 250 });
      expect((await board(u)).status).toBe(402);
    });

    it('review queue new-card budget follows the plan (free 10, pro/founder unlimited, D-647)', async () => {
      const [f, p, fo] = [await newUser(), await newUser(), await newUser()];
      await sub(p, {});
      await sub(fo, { plan: 'founder' });
      const { getBoardQueue } = await import('../review/queue');
      for (const [u, n] of [[f, 10], [p, 30], [fo, 30]] as const) {
        const b = (await board(u)).json.data!.id;
        await dbm.db.insert(dbm.cards).values(Array.from({ length: 30 }, (_, i) => ({ boardId: b, title: `n${i}`, order: i })));
        const r = await getBoardQueue(u, b, { now: new Date() });
        expect(r.ok && r.data.filter((i) => i.reason === 'new')).toHaveLength(n);
      }
    });
  });
});
