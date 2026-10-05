// Integration: needs local Supabase; skipped otherwise. 2020 clock so only rows made here qualify.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notify } from '@remoa/contracts';

config({ path: '../../.env' });
const DAY = 86_400_000;

describe.skipIf(!process.env.DATABASE_URL)('inactivity.check (G18 F26)', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let job: typeof import('./inactivity');
  const now = new Date('2020-06-15T13:00:00Z');
  const calls: { userId: string; payload: { reference: string; email?: { days: number; dueCards: number } } }[] = [];
  const notify: Notify = async (userId, _type, payload) => {
    calls.push({ userId, payload: payload as (typeof calls)[number]['payload'] });
    return { inApp: 'not_applicable', notificationId: null, email: 'queued', emailDeliveryId: null };
  };

  const newUser = async (o: { lastSessionDaysAgo: number; due?: boolean }) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    const [b] = await dbm.db.insert(dbm.boards).values({ userId: id, title: 'Mapa' }).returning();
    const [c] = await dbm.db.insert(dbm.cards).values({ boardId: b!.id, type: 'concept', title: 'c', order: 0 }).returning();
    const last = new Date(now.getTime() - o.lastSessionDaysAgo * DAY);
    await dbm.db.insert(dbm.sessions).values({ userId: id, kind: 'daily', startedAt: last });
    const due = o.due === false ? new Date(now.getTime() + 30 * DAY) : new Date(now.getTime() - 2 * DAY);
    await dbm.db.insert(dbm.fsrsState).values({ userId: id, cardId: c!.id, stability: 5, difficulty: 5, due, reps: 3, lastReview: last, state: 'review', scheduledDays: 5, createdAt: last });
    return id;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    job = await import('./inactivity');
  });
  afterAll(async () => {
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`);
  });

  it('> 10 days away with cards due: one notice per absence (stable reference); not if recent, nothing due, capped or long gone', async () => {
    const away = await newUser({ lastSessionDaysAgo: 14 });
    const recent = await newUser({ lastSessionDaysAgo: 5 });
    const nothing = await newUser({ lastSessionDaysAgo: 14, due: false });
    const capped = await newUser({ lastSessionDaysAgo: 20 });
    for (const d of [10, 40]) {
      await dbm.db.execute(sql`insert into email_deliveries (user_id, template, reference, to_hash, created_at)
        values (${capped}, 'inactivity', ${uuid()}, ${'a'.repeat(64)}, ${new Date(now.getTime() - d * DAY).toISOString()}::timestamptz)`);
    }
    const gone = await newUser({ lastSessionDaysAgo: 90 });

    await job.sendInactivityNotices(now, notify);
    await job.sendInactivityNotices(new Date(now.getTime() + DAY), notify); // next day: same absence, same reference
    const of = (u: string) => calls.filter((c) => c.userId === u);
    for (const u of [recent, nothing, capped, gone]) expect(of(u)).toHaveLength(0);
    expect(of(away)).toHaveLength(2);
    expect(of(away)[0]!.payload).toMatchObject({ email: { days: 14, dueCards: 1 } });
    expect(of(away)[0]!.payload.reference).toBe(of(away)[1]!.payload.reference); // notify() dedupes: one e-mail per absence
  });
});
