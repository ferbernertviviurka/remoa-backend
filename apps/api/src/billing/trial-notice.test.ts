// D-1213 integration: the "teste do Pro termina" sweep. Needs TEST_DATABASE_URL; skipped otherwise. 2020 clock so only rows made here qualify.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notify } from '@remoa/contracts';
import { dropTrial } from '../test-trial';

config({ path: '../../.env' });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!process.env.DATABASE_URL)('D-1213 trial ending notice', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let job: typeof import('./trial-notice');
  const now = new Date('2020-03-10T12:00:00Z');
  type Call = { userId: string; type: string; payload: { reference: string; href?: string; data: { endsAt: string; last: boolean }; email: { version: string; name: string | null; timezone: string; plansUrl: string } } };
  const calls: Call[] = [];
  const notify: Notify = async (userId, type, payload) => {
    calls.push({ userId, type, payload: payload as Call['payload'] });
    return { inApp: 'created', notificationId: null, email: 'queued', emailDeliveryId: null };
  };
  const of = (u: string) => calls.filter((c) => c.userId === u);

  const withTrial = async (endsInMs: number, o: { revoked?: boolean } = {}) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}, ${`${id}@test.local`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{"name":"Ana Souza"}'::jsonb)`);
    await dropTrial(id);
    const ends = new Date(now.getTime() + endsInMs);
    await dbm.db.execute(sql`insert into entitlement_grants (user_id, source, starts_at, ends_at, revoked_at, revoked_reason)
      values (${id}, 'trial', ${new Date(ends.getTime() - 15 * DAY).toISOString()}::timestamptz, ${ends.toISOString()}::timestamptz,
        ${o.revoked ? now.toISOString() : null}::timestamptz, ${o.revoked ? 'manual' : null}::grant_revoke_reason)`);
    return id;
  };

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    job = await import('./trial-notice');
  });
  afterAll(async () => {
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`);
  });

  it('d3 inside the 3-day window, d0 on the last day (only d0 if d3 was missed), with a stable reference per grant and version', async () => {
    const soon = await withTrial(2 * DAY + 20 * HOUR);
    const today = await withTrial(5 * HOUR);
    const far = await withTrial(4 * DAY);
    const ended = await withTrial(-HOUR);

    await job.sweepTrialNotices(now, notify);
    expect(of(soon)).toHaveLength(1);
    expect(of(soon)[0]).toMatchObject({
      type: 'trial_ending',
      payload: { href: '/app/planos', data: { last: false }, email: { version: 'd3', name: 'Ana', timezone: 'America/Sao_Paulo' } },
    });
    expect(of(soon)[0]!.payload.reference).toMatch(/^trial:[0-9a-f-]{36}:d3$/);
    expect(of(soon)[0]!.payload.email.plansUrl).toMatch(/\/app\/planos$/);
    expect(of(today)).toHaveLength(1);
    expect(of(today)[0]!.payload).toMatchObject({ data: { last: true }, email: { version: 'd0' } });
    expect(of(far)).toHaveLength(0);
    expect(of(ended)).toHaveLength(0);

    await job.sweepTrialNotices(new Date(now.getTime() + 2 * DAY), notify); // soon is now on its last day
    expect(of(soon).map((c) => c.payload.email.version)).toEqual(['d3', 'd0']);
    expect(of(soon)[1]!.payload.reference).toBe(of(soon)[0]!.payload.reference.replace(/:d3$/, ':d0'));
  });

  it('skips a revoked trial, a paying subscriber and a trial a non-trial grant takes over from', async () => {
    const revoked = await withTrial(DAY, { revoked: true });
    const paying = await withTrial(DAY);
    await dbm.db.execute(sql`insert into subscriptions (user_id, plan, status, renews_at) values (${paying}, 'pro', 'active', ${new Date(now.getTime() + 30 * DAY).toISOString()}::timestamptz)
      on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, renews_at = excluded.renews_at`);
    const founder = await withTrial(DAY);
    await dbm.db.execute(sql`insert into subscriptions (user_id, plan, status) values (${founder}, 'founder', 'active')
      on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`);
    const chained = await withTrial(DAY);
    await dbm.db.execute(sql`insert into entitlement_grants (user_id, source, starts_at, ends_at)
      values (${chained}, 'support', ${new Date(now.getTime() + DAY).toISOString()}::timestamptz, ${new Date(now.getTime() + 31 * DAY).toISOString()}::timestamptz)`);
    const lapsed = await withTrial(DAY);
    await dbm.db.execute(sql`insert into subscriptions (user_id, plan, status, renews_at) values (${lapsed}, 'pro', 'canceled', ${new Date(now.getTime() - DAY).toISOString()}::timestamptz)
      on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, renews_at = excluded.renews_at`);

    await job.sweepTrialNotices(now, notify);
    for (const u of [revoked, paying, founder, chained]) expect(of(u)).toHaveLength(0);
    expect(of(lapsed)).toHaveLength(1);
  });
});
