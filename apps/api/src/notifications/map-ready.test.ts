// G18 F26 FR-4: map_ready after a generation or import. Quick (<= 60 s) = in-app only; slower also gets the e-mail; once per map.
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureEmails, templateOf } from '../test-email';
import { MAP_READY_QUICK_MS, notifyMapReady } from './map-ready';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('notifyMapReady (local Supabase)', () => {
  const sent = captureEmails();
  const users: string[] = [];
  let db: typeof import('@remoa/db')['db'];
  let supa: ReturnType<typeof import('../account/auth-admin')['adminClient']>;
  beforeAll(async () => {
    supa = (await import('../account/auth-admin')).adminClient();
    db = (await import('@remoa/db')).db;
  });
  afterAll(async () => {
    for (const id of users) await supa.auth.admin.deleteUser(id);
  });

  const setup = async () => {
    const { data, error } = await supa.auth.admin.createUser({ email: `g18m-${randomUUID()}@test.local`, email_confirm: true });
    if (error) throw error;
    const userId = data.user.id;
    users.push(userId);
    const [b] = await db.execute<{ id: string }>(sql`insert into boards (user_id, title) values (${userId}, 'Sepse') returning id`);
    return { userId, boardId: b!.id, email: data.user.email! };
  };
  const rows = (userId: string) => db.execute<{ data: { title: string } }>(sql`select data from notifications where user_id = ${userId} and type = 'map_ready'`);
  const mails = (email: string) => sent.filter((m) => m.to === email && templateOf(m) === 'map-ready');

  it('quick run: notification row, no e-mail; slow run: both; a repeat changes nothing', async () => {
    const quick = await setup();
    await notifyMapReady({ ...quick, origin: 'text', tookMs: MAP_READY_QUICK_MS });
    expect((await rows(quick.userId)).map((r) => r.data.title)).toEqual(['Sepse']);
    expect(mails(quick.email)).toHaveLength(0);

    const slow = await setup();
    await notifyMapReady({ ...slow, origin: 'pdf', tookMs: MAP_READY_QUICK_MS + 1 });
    await notifyMapReady({ ...slow, origin: 'pdf', tookMs: MAP_READY_QUICK_MS + 1 });
    expect(await rows(slow.userId)).toHaveLength(1);
    expect(mails(slow.email)).toHaveLength(1);
    expect(mails(slow.email)[0]!.text).toContain(`/app/mapas/${slow.boardId}`);
  });

  it("another user's board id notifies nobody", async () => {
    const a = await setup();
    const b = await setup();
    await notifyMapReady({ userId: b.userId, boardId: a.boardId, origin: 'anki', tookMs: 120_000 });
    expect(await rows(b.userId)).toHaveLength(0);
    expect(mails(b.email)).toHaveLength(0);
  });
});
