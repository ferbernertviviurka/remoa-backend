// F31 FR-10 (D-1480): trail mode of the new cards. Integration: needs local Supabase; skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: '../../.env' });
const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('queue: modo trilha', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let q: typeof import('./queue');

  const newUser = async () => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    return id;
  };
  const mkBoard = async (userId: string, trail: boolean) => {
    const [b] = await dbm.db.insert(dbm.boards).values({ userId, title: 'Mapa', ...(trail ? { path: { slug: `t-${uuid()}` } as never } : {}) }).returning();
    return b!.id;
  };
  const mkCard = async (boardId: string, order: number, pathOrder: number | null) =>
    (await dbm.db.insert(dbm.cards).values({ boardId, type: 'concept', title: `c${order}`, order, pathOrder, payload: {} }).returning())[0]!.id;
  const seen = (userId: string, cardId: string) => {
    const t = new Date(Date.now() - 20 * DAY);
    return dbm.db.insert(dbm.fsrsState).values({ userId, cardId, subId: '', stability: 30, difficulty: 5, due: new Date(Date.now() + 10 * DAY), reps: 3, lapses: 0, lastReview: t, state: 'review', scheduledDays: 30, createdAt: t });
  };
  const ids = async (u: string, b: string, studyOrder?: 'trail' | 'mixed') => {
    const r = await q.getBoardQueue(u, b, { now: new Date(), studyOrder });
    return r.ok ? r.data.filter((i) => i.reason === 'new').map((i) => i.cardId) : [];
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    q = await import('./queue');
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('orders by path_order and holds back cards whose prerequisite was not seen; releases it after review', async () => {
    const u = await newUser();
    const b = await mkBoard(u, true);
    // `order` is the reverse of the trail on purpose; z has no path_order (comes last)
    const [c, a, bb, z] = [await mkCard(b, 1, 30), await mkCard(b, 2, 10), await mkCard(b, 3, 20), await mkCard(b, 0, null)];
    await dbm.db.insert(dbm.cardPrereqs).values({ cardId: c, prereqCardId: bb });
    await dbm.db.insert(dbm.cardPrereqs).values({ cardId: bb, prereqCardId: a });
    expect(await ids(u, b)).toEqual([a, z]); // bb waits for a, c waits for bb
    await seen(u, a);
    expect(await ids(u, b)).toEqual([bb, z]);
    await seen(u, bb);
    expect(await ids(u, b)).toEqual([c, z]);
  });

  it('"Misturar" keeps the F03 order and ignores prerequisites; a map without path is unchanged', async () => {
    const u = await newUser();
    const b = await mkBoard(u, true);
    const [x, y] = [await mkCard(b, 1, 20), await mkCard(b, 2, 10)];
    await dbm.db.insert(dbm.cardPrereqs).values({ cardId: x, prereqCardId: y });
    expect(await ids(u, b, 'mixed')).toEqual([x, y]);
    expect(await ids(u, b)).toEqual([y]);
    const plain = await mkBoard(u, false);
    const [p1, p2] = [await mkCard(plain, 2, 10), await mkCard(plain, 1, 20)];
    await dbm.db.insert(dbm.cardPrereqs).values({ cardId: p2, prereqCardId: p1 });
    expect(await ids(u, plain)).toEqual([p2, p1]);
  });

  it('keeps the daily new-card limit (trail order picks the first ones)', async () => {
    const u = await newUser();
    await dbm.db.insert(dbm.userPreferences).values({ userId: u, newCardsPerDay: 5 });
    const b = await mkBoard(u, true);
    const cs = await Promise.all([7, 6, 5, 4, 3, 2, 1].map((n) => mkCard(b, 10 - n, n))); // path_order 7..1
    expect(await ids(u, b)).toEqual([...cs].reverse().slice(0, 5));
  });
});
