// G15 FR-18: p95 of getReviewHub (uncached) stays under 400 ms with 50k attempts and a realistic card set.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });

describe.skipIf(!process.env.DATABASE_URL)('review hub load', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');

  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((id) => `'${id}'`).join(',')})`));
  });

  it('answers in under 400 ms at p95 with 50k attempts and 500 cards', async () => {
    dbm = await import('@remoa/db');
    const { computeReviewHub } = await import('../review/hub');
    const userId = randomUUID();
    users.push(userId);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${userId}', '${userId}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    const [board] = await dbm.db.insert(dbm.boards).values({ userId, title: 'Carga', area: 'CM' }).returning();
    const rows = Array.from({ length: 500 }, (_, i) => ({ boardId: board!.id, type: 'concept' as const, title: `c${i}`, order: i, payload: {} }));
    const cards = await dbm.db.insert(dbm.cards).values(rows).returning({ id: dbm.cards.id });
    await dbm.db.execute(sql.raw(`
      insert into fsrs_state (user_id, card_id, sub_id, stability, difficulty, due, reps, lapses, last_review, state, scheduled_days, created_at)
      select '${userId}', c.id, '', 5, 5, now() + ((row_number() over ())::int % 20 - 5) * interval '1 day', 3, (row_number() over ())::int % 3, now() - interval '5 days', 'review', 5, now() - interval '5 days'
      from cards c where c.board_id = '${board!.id}' and c.id in (${cards.slice(0, 400).map((c) => `'${c.id}'`).join(',')})`));
    await dbm.db.execute(sql.raw(`
      insert into attempts (user_id, card_id, sub_id, mode, input_kind, grade, duration_ms, created_at)
      select '${userId}', '${cards[0]!.id}', '', 'hidden_card', 'self', 1 + (g % 4), 15000, now() - (g % 400) * interval '1 day' - (g % 24) * interval '1 hour'
      from generate_series(1, 50000) g`));

    await computeReviewHub(userId, new Date());
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const hub = await computeReviewHub(userId, new Date());
      samples.push(performance.now() - start);
      expect(hub.status).not.toBe('empty');
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.ceil(samples.length * 0.95) - 1]!).toBeLessThan(400);
  }, 120_000);
});
