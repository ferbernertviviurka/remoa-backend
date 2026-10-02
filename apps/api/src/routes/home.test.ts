// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeSummarySchema } from '@remoa/contracts';

config({ path: '../../.env' });

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe.skipIf(!process.env.DATABASE_URL)('/v1/home', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let home: typeof import('../home/home');

  const newUser = async (tz?: string) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (tz) await dbm.db.update(dbm.profiles).set({ timezone: tz }).where(eq(dbm.profiles.userId, id));
    return id;
  };
  const mkCards = async (userId: string, n = 1) => {
    const [b] = await dbm.db.insert(dbm.boards).values({ userId, title: 'Mapa' }).returning();
    const rows = Array.from({ length: n }, (_, i) => ({ id: uuid(), boardId: b!.id, type: 'concept' as const, title: `c${i}`, order: i }));
    await dbm.db.insert(dbm.cards).values(rows);
    return rows.map((r) => r.id);
  };
  const putState = (userId: string, cardId: string, due: Date, last = new Date(due.getTime() - 5 * DAY)) =>
    dbm.db.insert(dbm.fsrsState).values({ userId, cardId, stability: 5, difficulty: 5, due, reps: 3, lastReview: last, state: 'review', scheduledDays: 5, createdAt: last });
  const putAttempt = (userId: string, cardId: string, createdAt: string) =>
    dbm.db.insert(dbm.attempts).values({ userId, cardId, mode: 'hidden_card', inputKind: 'self', grade: 3, createdAt: new Date(createdAt) });

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    home = await import('../home/home');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('counts the study day (04:00 rollover), week Mon-Sun, upcoming and streak', async () => {
    const u = await newUser('America/Sao_Paulo');
    const [a, b, c, d] = await mkCards(u, 4);
    const now = new Date('2026-06-10T15:00:00Z'); // Wednesday 12:00 local
    await putState(u, a!, new Date('2026-06-01T12:00:00Z')); // overdue -> today
    await putState(u, b!, new Date('2026-06-11T12:00:00Z')); // Thursday
    await putState(u, c!, new Date('2026-06-13T12:00:00Z')); // Saturday
    await putState(u, d!, new Date('2026-06-20T12:00:00Z')); // beyond the week and upcoming
    await putAttempt(u, a!, '2026-06-10T12:00:00Z');
    await putAttempt(u, a!, '2026-06-10T13:00:00Z');
    await putAttempt(u, a!, '2026-06-10T06:30:00Z'); // 03:30 local: still the 06-09 study day
    await putAttempt(u, a!, '2026-06-08T12:00:00Z');
    const r = await home.getHomeSummary(u, now);
    expect(r.ok && homeSummarySchema.parse(r.data)).toEqual({
      reviewedToday: 2,
      dueToday: 1,
      streakDays: 3,
      week: [
        { date: '2026-06-08', done: 1, planned: 0 }, { date: '2026-06-09', done: 1, planned: 0 }, { date: '2026-06-10', done: 2, planned: 1 },
        { date: '2026-06-11', done: 0, planned: 1 }, { date: '2026-06-12', done: 0, planned: 0 }, { date: '2026-06-13', done: 0, planned: 1 },
        { date: '2026-06-14', done: 0, planned: 0 },
      ],
      upcoming: [
        { date: '2026-06-10', count: 1 }, { date: '2026-06-11', count: 1 }, { date: '2026-06-12', count: 0 }, { date: '2026-06-13', count: 1 },
      ],
    });
  });

  it('dueToday equals the due items of the daily queue; streak survives an empty today, breaks on a gap; isolated per user', async () => {
    const u = await newUser();
    const other = await newUser();
    const cards = await mkCards(u, 3);
    const now = new Date();
    for (const id of cards) await putState(u, id, new Date(now.getTime() - HOUR));
    await putAttempt(u, cards[0]!, new Date(now.getTime() - DAY).toISOString());
    await putAttempt(u, cards[0]!, new Date(now.getTime() - 3 * DAY).toISOString()); // gap at -2 days
    await putAttempt(other, (await mkCards(other))[0]!, now.toISOString());
    const queue = await (await import('../review/queue')).getDailyQueue(u, { now });
    const r = await home.getHomeSummary(u, now);
    expect(r.ok && r.data.dueToday).toBe(queue.ok ? queue.data.filter((i) => i.reason === 'due').length : -1);
    expect(r.ok && [r.data.reviewedToday, r.data.streakDays]).toEqual([0, 1]);
  });

  it('GET /v1/home: auth required, schema-valid; 500 cards in < 100 ms (median)', async () => {
    expect((await app.request('/v1/home')).status).toBe(401);
    const u = await newUser();
    const ids = await mkCards(u, 500);
    const real = Date.now();
    await dbm.db.insert(dbm.fsrsState).values(
      ids.map((cardId, i) => ({ userId: u, cardId, stability: 5, difficulty: 5, due: new Date(real + ((i % 9) - 3) * DAY), reps: 3, lastReview: new Date(real - DAY), state: 'review' as const, scheduledDays: 5 })),
    );
    const get = () => app.request('/v1/home', { headers: { authorization: `Bearer ${u}` } });
    await get();
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const res = await get();
      ms.push(performance.now() - t);
      expect(res.status).toBe(200);
      expect(homeSummarySchema.safeParse(((await res.json()) as { data: unknown }).data).success).toBe(true);
    }
    expect([...ms].sort((x, y) => x - y)[2]!).toBeLessThan(100);
  });
});
