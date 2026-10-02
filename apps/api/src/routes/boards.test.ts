// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardGraph, MapOp } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/boards', () => {
  const a = uuid();
  const b = uuid();
  const tokens: Record<string, string> = { ta: a, tb: b };
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;

  const call = async (t: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/boards${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { ok?: true; data?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const newBoard = async (t = 'ta', title = 'Mapa') => (await call(t, 'POST', '', { title })).json.data.id as string;
  const graph = async (t: string, id: string) => (await call(t, 'GET', `/${id}`)).json.data as BoardGraph;
  const ops = (t: string, list: MapOp[]) => call(t, 'POST', '/ops', { ops: list });
  const mkCard = (boardId: string, id = uuid(), x = 0, y = 0): MapOp => ({ op: 'createCard', opId: uuid(), boardId, card: { id, type: 'concept', title: `c-${id.slice(0, 4)}`, position: { x, y } } });
  const mkEdge = (boardId: string, from: string, to: string, label: string | null = null, id = uuid()): MapOp => ({ op: 'createEdge', opId: uuid(), boardId, edge: { id, fromCardId: from, toCardId: to, label } });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => tokens[t] ?? null });
    for (const id of [a, b]) {
      await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
      await dbm.db.insert(dbm.subscriptions).values({ userId: id, plan: 'pro', status: 'active' }); // F08: these tests are not about plan limits
    }
  });
  afterAll(async () => {
    if (dbm) await dbm.db.execute(sql.raw(`delete from auth.users where id in ('${a}', '${b}')`));
  });

  it('create, list, get, rename, archive, unarchive', async () => {
    const created = await call('ta', 'POST', '', { title: '  Cardio  ' });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    expect(created.json.data.title).toBe('Cardio');

    const list = await call('ta', 'GET', '');
    expect(list.json.data.map((x: { id: string }) => x.id)).toContain(id);
    expect((await call('tb', 'GET', '')).json.data.map((x: { id: string }) => x.id)).not.toContain(id);
    expect(await graph('ta', id)).toMatchObject({ cards: [], edges: [] });

    expect((await call('ta', 'PATCH', `/${id}`, { title: 'Cardiologia' })).json.data.title).toBe('Cardiologia');
    const archived = await call('ta', 'PATCH', `/${id}`, { archived: true });
    expect(archived.json.data.archivedAt).toBeTruthy();
    expect((await call('ta', 'GET', '')).json.data.map((x: { id: string }) => x.id)).not.toContain(id);
    expect((await call('ta', 'GET', `/${id}`)).status).toBe(200);
    expect((await call('ta', 'PATCH', `/${id}`, { archived: false })).json.data.archivedAt).toBeNull();
    expect((await call('ta', 'GET', '')).json.data.map((x: { id: string }) => x.id)).toContain(id);
  });

  it('ops: build, move, label, soft delete hides edge, re-create restores; replay is a no-op', async () => {
    const id = await newBoard();
    const [c1, c2, c3] = [uuid(), uuid(), uuid()];
    const [e1, e2] = [uuid(), uuid()];
    const batch: MapOp[] = [
      mkCard(id, c1), mkCard(id, c2), mkCard(id, c3), mkEdge(id, c1, c2, '  causa ', e1), mkEdge(id, c2, c3, '   ', e2),
      { op: 'moveCards', opId: uuid(), boardId: id, moves: [{ cardId: c1, position: { x: 10.6, y: -4.2 } }] },
    ];
    const first = await ops('ta', batch);
    expect(first.status).toBe(200);
    expect(first.json.data.applied).toEqual(batch.map((o) => o.opId));
    const replay = await ops('ta', batch);
    expect(replay.status).toBe(200);

    let g = await graph('ta', id);
    expect(g.cards).toHaveLength(3);
    expect(g.cards.find((c) => c.id === c1)?.position).toEqual({ x: 11, y: -4 });
    expect(g.edges.find((e) => e.id === e1)?.label).toBe('causa');
    expect(g.edges.find((e) => e.id === e2)?.label).toBeNull();

    await ops('ta', [{ op: 'updateEdgeLabel', opId: uuid(), boardId: id, edgeId: e2, label: ' leva a ' }]);
    expect((await graph('ta', id)).edges.find((e) => e.id === e2)?.label).toBe('leva a');

    await ops('ta', [{ op: 'deleteCards', opId: uuid(), boardId: id, cardIds: [c2] }]);
    g = await graph('ta', id);
    expect(g.cards.map((c) => c.id).sort()).toEqual([c1, c3].sort());
    expect(g.edges).toHaveLength(0);
    const summary = (await call('ta', 'GET', '')).json.data.find((x: { id: string }) => x.id === id);
    expect(summary).toMatchObject({ cardCount: 2, edgeCount: 0 });

    await ops('ta', [mkCard(id, c2)]);
    g = await graph('ta', id);
    expect(g.cards).toHaveLength(3);
    expect(g.edges).toHaveLength(2);

    await ops('ta', [{ op: 'deleteEdges', opId: uuid(), boardId: id, edgeIds: [e1] }]);
    expect((await graph('ta', id)).edges.map((e) => e.id)).toEqual([e2]);
  });

  it('duplicate copies live cards and remapped edges; works for own and seed boards', async () => {
    const id = await newBoard('ta', 'Origem');
    const [c1, c2, dead] = [uuid(), uuid(), uuid()];
    await ops('ta', [mkCard(id, c1, 5, 6), mkCard(id, c2), mkCard(id, dead), mkEdge(id, c1, c2, 'x'), mkEdge(id, c1, dead, 'y'),
      { op: 'deleteCards', opId: uuid(), boardId: id, cardIds: [dead] }]);

    const dup = await call('ta', 'POST', `/${id}/duplicate`, { title: 'Cópia' });
    expect(dup.status).toBe(201);
    expect(dup.json.data).toMatchObject({ title: 'Cópia', userId: a, sourceBoardId: id, status: 'private' });
    const g = await graph('ta', dup.json.data.id);
    expect(g.cards).toHaveLength(2);
    expect(g.cards.map((c) => c.id)).not.toContain(c1);
    expect(g.edges).toHaveLength(1);
    expect(g.cards.map((c) => c.id)).toEqual(expect.arrayContaining([g.edges[0]!.fromCardId, g.edges[0]!.toCardId]));
    expect(g.cards.some((c) => c.position?.x === 5 && c.position.y === 6)).toBe(true);

    const [seed] = await dbm.db.insert(dbm.boards).values({ userId: a, title: 'seed', status: 'seed_approved' }).returning();
    await dbm.db.insert(dbm.cards).values({ boardId: seed!.id, title: 'sc', status: 'approved' });
    const fromSeed = await call('tb', 'POST', `/${seed!.id}/duplicate`, { title: 'Meu seed' });
    expect(fromSeed.status).toBe(201);
    expect(fromSeed.json.data.userId).toBe(b);
    const copied = await call('tb', 'GET', `/${fromSeed.json.data.id}`);
    expect(copied.json.data.cards.map((c: { status: string }) => c.status)).toEqual(['draft']);
    expect((await call('tb', 'GET', `/${seed!.id}`)).status).toBe(200);
    expect((await call('tb', 'PATCH', `/${seed!.id}`, { title: 'x' })).status).toBe(404);
  });

  it('other users get 404 and data is unchanged', async () => {
    const id = await newBoard('ta', 'Privado');
    const c1 = uuid();
    await ops('ta', [mkCard(id, c1)]);
    expect((await call('tb', 'GET', `/${id}`)).status).toBe(404);
    expect((await call('tb', 'PATCH', `/${id}`, { title: 'hack' })).status).toBe(404);
    expect((await call('tb', 'POST', `/${id}/duplicate`, { title: 'x' })).status).toBe(404);
    const bad = await ops('tb', [{ op: 'deleteCards', opId: uuid(), boardId: id, cardIds: [c1] }]);
    expect(bad.status).toBe(404);
    const g = await graph('ta', id);
    expect(g.board.title).toBe('Privado');
    expect(g.cards).toHaveLength(1);
  });

  it('rejects bad edges and rolls back the whole batch', async () => {
    const id = await newBoard();
    const other = await newBoard('ta', 'Outro');
    const [c1, c2, x] = [uuid(), uuid(), uuid()];
    await ops('ta', [mkCard(id, c1), mkCard(id, c2), mkCard(other, x)]);
    const self = await ops('ta', [mkEdge(id, c1, c1)]);
    expect(self.status).toBe(422);
    const cross = await ops('ta', [mkCard(id), mkEdge(id, c1, x)]);
    expect(cross.status).toBe(422);
    expect(cross.json.error?.code).toBe('validation');
    expect((await graph('ta', id)).cards).toHaveLength(2); // the createCard before the bad edge was rolled back
  });

  it('caps live cards at 500', async () => {
    const id = await newBoard();
    await dbm.db.insert(dbm.cards).values(Array.from({ length: 500 }, (_, i) => ({ boardId: id, title: `c${i}` })));
    const over = await ops('ta', [mkCard(id)]);
    expect(over.status).toBe(422);
    expect(over.json.error).toMatchObject({ code: 'validation', message: 'board card limit' });
  });

  it('out-of-range positions are a 422, not a 500', async () => {
    const id = await newBoard();
    expect((await ops('ta', [mkCard(id, uuid(), 1e30, 0)])).status).toBe(422);
  });

  it('invalid ids and bodies', async () => {
    expect((await call('ta', 'GET', '/not-a-uuid')).status).toBe(404);
    expect((await call('ta', 'PATCH', '/nope', { title: 'x' })).status).toBe(404);
    expect((await call('ta', 'POST', '/nope/duplicate', { title: 'x' })).status).toBe(404);
    expect((await call('ta', 'POST', '', { title: '' })).status).toBe(422);
    expect((await call('ta', 'PATCH', `/${uuid()}`, {})).status).toBe(422);
    expect((await call('ta', 'POST', '/ops', { ops: [] })).status).toBe(422);
    const res = await app.request('/v1/boards', { method: 'POST', headers: { authorization: 'Bearer ta' }, body: 'not json' });
    expect(res.status).toBe(422);
    expect((await app.request('/v1/boards')).status).toBe(401);
  });
});
