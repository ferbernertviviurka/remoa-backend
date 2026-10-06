import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noticeFunctions, noticeJobs } from './notices';

config({ path: '../../.env' });
const DAY = 86_400_000;

describe('notice jobs (G18)', () => {
  it('registers the crons (G18 + F27 blog + G21 stats.rebuild)', () => {
    expect(Object.fromEntries(Object.entries(noticeJobs).map(([k, j]) => [k, j.cron]))).toEqual({
      'calendar.dispatch-reminders': '*/5 * * * *',
      'review.reminder': '*/15 * * * *',
      'inactivity.check': '0 13 * * *',
      'notifications.retention': '30 6 * * *',
      'calendar.cleanup': '45 6 * * *',
      'stats.rebuild': '0 8 * * 0',
      'sitemap.daily': '0 6 * * *',
      'blog.publish-scheduled': '*/5 * * * *',
      'blog.cleanup': '15 7 * * *',
    });
    expect(noticeFunctions).toHaveLength(9);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('notifications.retention and calendar.cleanup', () => {
  let dbm: typeof import('@remoa/db');
  let jobs: typeof import('./notices');
  const user = uuid();
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    jobs = await import('./notices');
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${user}', '${user}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
  });
  afterAll(async () => {
    await dbm.db.execute(sql`delete from auth.users where id = ${user}`);
  });

  it('deletes read notices after 90 days and unread after 180', async () => {
    const add = (key: string, createdDaysAgo: number, read: boolean) =>
      dbm.db.execute(sql`insert into notifications (user_id, type, category, data, idempotency_key, created_at, read_at)
        values (${user}, 'review_reminder', 'review', '{"cards":1}', ${key}, ${ago(createdDaysAgo)}::timestamptz, ${read ? ago(createdDaysAgo) : null}::timestamptz)`);
    await add('read-old', 91, true);
    await add('read-new', 89, true);
    await add('unread-mid', 120, false);
    await add('unread-old', 181, false);
    await jobs.purgeOldNotifications(now);
    const left = await dbm.db.execute<{ k: string }>(sql`select idempotency_key as k from notifications where user_id = ${user} order by k`);
    expect(left.map((r) => r.k)).toEqual(['read-new', 'unread-mid']);
  });

  it('purges events deleted more than 30 days ago (reminders cascade), keeps the rest', async () => {
    const [l] = await dbm.db.execute<{ id: string }>(sql`insert into calendar_labels (user_id, name, color) values (${user}, 'Prova', 'orange') returning id`);
    const add = async (deletedDaysAgo: number | null) => {
      const [e] = await dbm.db.execute<{ id: string }>(sql`insert into calendar_events (user_id, title, label_id, starts_at, timezone, deleted_at)
        values (${user}, 'Prova', ${l!.id}, now(), 'America/Sao_Paulo', ${deletedDaysAgo === null ? null : ago(deletedDaysAgo)}::timestamptz) returning id`);
      await dbm.db.execute(sql`insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at, status) values (${user}, ${e!.id}, 'd1', '2026-01-01', now(), 'canceled')`);
      return e!.id;
    };
    const old = await add(31);
    const recent = await add(29);
    const live = await add(null);
    await jobs.purgeDeletedEvents(now);
    const left = await dbm.db.execute<{ id: string }>(sql`select id from calendar_events where user_id = ${user}`);
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([recent, live]));
    expect(await dbm.db.execute(sql`select 1 from calendar_reminders where event_id = ${old}`)).toHaveLength(0);
  });
});
