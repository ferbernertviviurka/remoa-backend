// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate && pnpm db:seed`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coverageRowSchema, matrixItemSchema, type CoverageRow, type MatrixItem } from '@remoa/contracts';

config({ path: '../../.env' });

const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('/v1/matrix, /v1/coverage, createBoard matrixItemId', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const call = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${user}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const all = async (u: string) => (await call(u, 'GET', '/matrix/items?area=CM')).json.data as MatrixItem[];
  const items = async (u: string) => (await all(u)).filter((i) => i.parentId); // topics only; groups are not link targets
  const mkCards = async (boardId: string, n: number) => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: uuid(), boardId, type: 'concept' as const, title: `c${i}`, order: i }));
    await dbm.db.insert(dbm.cards).values(rows);
    return rows.map((r) => r.id);
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('lists the area items ordered by code; validates area; requires auth', async () => {
    const u = await newUser();
    const list = await all(u);
    expect(list.length).toBeGreaterThanOrEqual(9);
    list.forEach((i) => matrixItemSchema.parse(i));
    expect(list.map((i) => i.code)).toEqual([...list.map((i) => i.code)].sort());
    expect(list[0]!.code).toBe('CM.01');
    expect((await call(u, 'GET', '/matrix/items?area=XX')).status).toBe(422);
    expect((await call(u, 'GET', '/matrix/items')).status).toBe(422);
    expect((await app.request('/v1/matrix/items?area=CM')).status).toBe(401);
  });

  it('createBoard with matrixItemId links it (boards column + board_matrix_items); unknown id -> 422 and no board', async () => {
    const u = await newUser();
    const [item] = await items(u);
    const ok = await call(u, 'POST', '/boards', { title: 'Cardio', matrixItemId: item!.id });
    expect(ok.status).toBe(201);
    expect(ok.json.data.matrixItemId).toBe(item!.id);
    const links = await dbm.db.select().from(dbm.boardMatrixItems).where(eq(dbm.boardMatrixItems.boardId, ok.json.data.id));
    expect(links.map((l) => l.matrixItemId)).toEqual([item!.id]);
    expect((await call(u, 'GET', `/boards/${ok.json.data.id}`)).json.data.board.matrixItemId).toBe(item!.id);
    expect(((await call(u, 'GET', '/boards')).json.data as { id: string; matrixItemId: string }[]).find((b) => b.id === ok.json.data.id)!.matrixItemId).toBe(item!.id);

    const bad = await call(u, 'POST', '/boards', { title: 'Sem item', matrixItemId: uuid() });
    const group = (await all(u)).find((i) => !i.parentId)!;
    expect((await call(u, 'POST', '/boards', { title: 'Grupo', matrixItemId: group.id })).status).toBe(422);
    expect(bad.status).toBe(422);
    expect((await call(u, 'POST', '/boards', { title: 'Sem item', matrixItemId: 'x' })).status).toBe(422);
    expect((await call(u, 'GET', '/boards')).json.data).toHaveLength(1);
    const plain = await call(u, 'POST', '/boards', { title: 'Livre' });
    expect(plain.json.data.matrixItemId).toBeNull();
  });

  it('coverage: cards of linked, live boards / target, recall of reviewed cards; unlinked items and other users left out', async () => {
    const u = await newUser();
    const other = await newUser();
    const [i1, i2] = await items(u);
    expect((await call(u, 'GET', '/coverage')).json.data).toEqual([]);
    const b1 = (await call(u, 'POST', '/boards', { title: 'A', matrixItemId: i1!.id })).json.data.id as string;
    const b2 = (await call(u, 'POST', '/boards', { title: 'B', matrixItemId: i1!.id })).json.data.id as string;
    const archived = (await call(u, 'POST', '/boards', { title: 'C', matrixItemId: i2!.id })).json.data.id as string;
    await call(u, 'PATCH', `/boards/${archived}`, { archived: true });
    const [c1, c2, dead] = await mkCards(b1, 3);
    await mkCards(b2, 1);
    await mkCards(archived, 5);
    await dbm.db.update(dbm.cards).set({ deletedAt: new Date() }).where(eq(dbm.cards.id, dead!));
    await dbm.db.insert(dbm.fsrsState).values({
      userId: u, cardId: c1!, stability: 10, difficulty: 5, due: new Date(Date.now() + DAY), reps: 3, lastReview: new Date(Date.now() - DAY), state: 'review', scheduledDays: 5,
    });
    void c2;

    const r = await call(u, 'GET', '/coverage');
    expect(r.status).toBe(200);
    const rows = r.json.data as CoverageRow[];
    rows.forEach((x) => coverageRowSchema.parse(x));
    expect(rows).toHaveLength(1); // i2's only board is archived
    expect(rows[0]).toMatchObject({ matrixItemId: i1!.id, code: i1!.code, boards: 2, cards: 3, targetCards: i1!.targetCards, coverage: Math.min(100, (3 / i1!.targetCards) * 100) });
    expect(rows[0]!.avgRetrievability).toBeGreaterThan(0.8);
    expect(rows[0]!.avgRetrievability).toBeLessThanOrEqual(1);
    expect((await call(other, 'GET', '/coverage')).json.data).toEqual([]);
    expect((await app.request('/v1/coverage')).status).toBe(401);
  });

  it('coverage caps at 100 and has null recall without reviews', async () => {
    const u = await newUser();
    const [item] = await items(u);
    const b = (await call(u, 'POST', '/boards', { title: 'Grande', matrixItemId: item!.id })).json.data.id as string;
    await mkCards(b, item!.targetCards + 5);
    const [row] = (await call(u, 'GET', '/coverage')).json.data as CoverageRow[];
    expect(row).toMatchObject({ cards: item!.targetCards + 5, coverage: 100, avgRetrievability: null });
  });

  describe('suggest', () => {
    const codes: string[] = [];
    const mkItem = async (title: string) => {
      const code = `TEST-${uuid()}`;
      codes.push(code);
      const [r] = await dbm.db.insert(dbm.matrixItems).values({ area: 'CM', code, title, targetCards: 40 }).returning();
      return r!.id;
    };
    afterAll(async () => {
      if (codes.length) await dbm.db.execute(sql.raw(`delete from matrix_items where code in (${codes.map((c) => `'${c}'`).join(',')})`));
    });

    it('Sepse suggests the sepse item (case-insensitive), junk returns [], validates, requires auth', async () => {
      const u = await newUser();
      const id = await mkItem('Sepse e choque séptico');
      await mkItem('Insuficiência cardíaca');
      const s = async (q: string) => (await call(u, 'GET', `/matrix/suggest?title=${encodeURIComponent(q)}`)).json.data as MatrixItem[];
      for (const q of ['Sepse', 'sepse', '  SEPSE  ']) {
        const r = await s(q);
        r.forEach((x) => matrixItemSchema.parse(x));
        expect(r.map((x) => x.id)).toContain(id);
        expect(r.length).toBeLessThanOrEqual(3);
      }
      expect(await s('zzqxw jjkv')).toEqual([]);
      expect((await call(u, 'GET', '/matrix/suggest?title=%20%20')).status).toBe(422);
      expect((await call(u, 'GET', '/matrix/suggest')).status).toBe(422);
      expect((await call(u, 'GET', `/matrix/suggest?title=${'a'.repeat(201)}`)).status).toBe(422);
      expect((await app.request('/v1/matrix/suggest?title=sepse')).status).toBe(401);
    });
  });

  it('link/unlink: own board only, unknown item 422, idempotent, primary switches on unlink, coverage follows', async () => {
    const u = await newUser();
    const other = await newUser();
    const [i1, i2] = await items(u);
    const b = (await call(u, 'POST', '/boards', { title: 'Livre' })).json.data.id as string;
    const primary = async () => (await call(u, 'GET', `/boards/${b}`)).json.data.board.matrixItemId as string | null;
    const linkRows = () => dbm.db.select().from(dbm.boardMatrixItems).where(eq(dbm.boardMatrixItems.boardId, b));

    const l1 = { boardId: b, matrixItemId: i1!.id };
    const l2 = { boardId: b, matrixItemId: i2!.id };
    expect((await call(u, 'POST', '/matrix/links', l1)).json.data).toEqual(l1);
    expect((await call(u, 'POST', '/matrix/links', l1)).status).toBe(200);
    expect(await linkRows()).toHaveLength(1);
    expect(await primary()).toBe(i1!.id);
    await call(u, 'POST', '/matrix/links', l2);
    expect(await primary()).toBe(i1!.id);
    expect(await linkRows()).toHaveLength(2);
    await mkCards(b, 2);
    expect(((await call(u, 'GET', '/coverage')).json.data as CoverageRow[]).map((r) => r.matrixItemId).sort()).toEqual([i1!.id, i2!.id].sort());

    expect((await call(other, 'POST', '/matrix/links', l1)).status).toBe(404);
    expect((await call(other, 'DELETE', '/matrix/links', l1)).status).toBe(404);
    // seed_approved boards are SELECT-visible to everyone under RLS; linking someone else's must still be 404, not a 500.
    const [seedB] = await dbm.db.insert(dbm.boards).values({ userId: other, title: 'Seed', status: 'seed_approved' }).returning();
    expect((await call(u, 'POST', '/matrix/links', { boardId: seedB!.id, matrixItemId: i1!.id })).status).toBe(404);
    expect((await call(u, 'DELETE', '/matrix/links', { boardId: seedB!.id, matrixItemId: i1!.id })).status).toBe(404);
    expect((await call(u, 'DELETE', '/matrix/links', { boardId: b })).status).toBe(422);
    expect((await call(u, 'POST', '/matrix/links', { boardId: b, matrixItemId: uuid() })).status).toBe(422);
    expect((await call(u, 'POST', '/matrix/links', { boardId: b })).status).toBe(422);
    expect((await call(u, 'POST', '/matrix/links', { boardId: uuid(), matrixItemId: i1!.id })).status).toBe(404);
    expect((await app.request('/v1/matrix/links', { method: 'POST' })).status).toBe(401);

    const del = await call(u, 'DELETE', '/matrix/links', l1);
    expect(del.status).toBe(200);
    expect(del.json.data).toBeNull();
    expect(await primary()).toBe(i2!.id);
    expect((await call(u, 'DELETE', '/matrix/links', l1)).status).toBe(200);
    await call(u, 'DELETE', '/matrix/links', l2);
    expect(await primary()).toBeNull();
    expect(await linkRows()).toHaveLength(0);
    expect((await call(u, 'GET', '/coverage')).json.data).toEqual([]);
  });
});
