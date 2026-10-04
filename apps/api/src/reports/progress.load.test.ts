// F11 FR-2: p95 of the progress query stays under 300 ms with 50k attempts.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });

describe.skipIf(!process.env.DATABASE_URL)('progress load', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');

  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((id) => `'${id}'`).join(',')})`));
  });

  it('answers in under 300 ms at p95 with 50k attempts', async () => {
    dbm = await import('@remoa/db');
    const { getProgress } = await import('./progress');
    const userId = randomUUID();
    users.push(userId);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${userId}', '${userId}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    const [board] = await dbm.db.insert(dbm.boards).values({ userId, title: 'Carga', area: 'CM' }).returning();
    const [card] = await dbm.db.insert(dbm.cards).values({ boardId: board!.id, type: 'concept', title: 'Sepse', payload: {} }).returning();
    await dbm.db.execute(sql.raw(`
      insert into attempts (user_id, card_id, sub_id, mode, input_kind, grade, created_at)
      select '${userId}', '${card!.id}', '', 'hidden_card', 'self', 4, now()
      from generate_series(1, 50000)
    `));

    await getProgress(userId, new Date());
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await getProgress(userId, new Date());
      samples.push(performance.now() - start);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.retention30d).toBe(1);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(300);
  }, 60_000);
});
