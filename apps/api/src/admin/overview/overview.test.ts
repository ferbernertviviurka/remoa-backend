// Integration (F19 T4): admin_metrics_daily job + GET /v1/admin/overview. Fixture lives in 2001 (São Paulo days) so other
// test files writing "today" can't move the numbers. Needs local Supabase.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@remoa/log';
import { adminOverviewSchema } from '@remoa/contracts';
import type { AdminEnv } from '../core';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('F19 overview + admin_metrics_daily', () => {
  let dbm: typeof import('@remoa/db');
  let metrics: typeof import('./metrics');
  let mod: typeof import('./routes');
  let core: typeof import('../core');
  let app: Hono<AdminEnv>;
  const users: string[] = [];
  const pays: string[] = [];
  // 2001-03-10 00:30 in São Paulo = 03:30Z; 2001-03-09 23:30 SP = 2001-03-10 02:30Z (previous SP day).
  const at = (iso: string) => new Date(iso);

  const mk = async (createdAt: Date) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role) values (${id}, ${id + '@test.local'}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    await dbm.db.execute(sql`update profiles set created_at = ${createdAt.toISOString()}::timestamptz where user_id = ${id}`);
    return id;
  };
  const pay = async (user: string, cents: number, status: 'paid' | 'refunded' | 'pending', createdAt: Date) => {
    const id = `pi_ov_${uuid()}`;
    pays.push(id);
    await dbm.db.insert(dbm.payments).values({ id, userId: user, amountCents: cents, method: 'pix', status, item: 'pro_monthly', createdAt, refundedAt: status === 'refunded' ? createdAt : null });
  };
  const day = async (d: string) => (await dbm.db.execute<Record<string, number>>(sql`select new_accounts, new_maps, new_pro, revenue_cents::int as revenue_cents, referrals_qualified, tickets_opened from admin_metrics_daily where day = ${d}`))[0];

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    metrics = await import('./metrics');
    core = await import('../core');
    mod = await import('./routes');
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('admin', { id: uuid(), name: 'Equipe', email: 'e@test.local' });
      c.set('authAt', Date.now());
      c.set('requestId', 'r-ov');
      c.set('log', createLogger({ requestId: 'r-ov' }));
      await next();
    });
    app.route('/overview', mod.overviewRoutes);

    const a = await mk(at('2001-03-10T03:30:00Z')); // SP 2001-03-10
    const b = await mk(at('2001-03-10T02:30:00Z')); // SP 2001-03-09 (time zone boundary)
    await mk(at('2001-03-03T12:00:00Z')); // previous 7-day period
    await dbm.db.insert(dbm.boards).values([
      { userId: a, title: 'Sepse', createdAt: at('2001-03-10T12:00:00Z') },
      { userId: a, title: 'Seed', status: 'seed_draft', createdAt: at('2001-03-10T12:00:00Z') }, // not a student map
    ]);
    await pay(a, 4200, 'paid', at('2001-03-10T13:00:00Z'));
    await pay(a, 4200, 'paid', at('2001-03-10T14:00:00Z')); // same user: new_pro counts once
    await pay(b, 39900, 'refunded', at('2001-03-10T13:00:00Z'));
    await pay(b, 999, 'pending', at('2001-03-10T13:00:00Z'));
    await pay(b, 1000, 'paid', at('2001-03-01T13:00:00Z')); // previous period revenue
    await dbm.db.execute(sql`insert into support_tickets (user_id, type, subject, created_at) values (${a}, 'bug', 'Erro na fila', '2001-03-10T15:00:00Z')`);
  });
  afterAll(async () => {
    if (!dbm) return;
    await dbm.db.execute(sql`delete from admin_metrics_daily where day < '2002-01-01'`);
    if (pays.length) await dbm.db.execute(sql`delete from payments where id in (${sql.join(pays.map((p) => sql`${p}`), sql`, `)})`);
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('metrics job: São Paulo days, idempotent upsert, backfill of a range', async () => {
    expect(metrics.spDay(at('2001-03-10T02:30:00Z'))).toBe('2001-03-09');
    expect(metrics.addDays('2001-03-01', -1)).toBe('2001-02-28');
    expect(await metrics.refreshMetrics('2001-02-20', '2001-03-12')).toBe(21);
    const first = await day('2001-03-10');
    expect(first).toMatchObject({ new_accounts: 1, new_maps: 1, new_pro: 1, revenue_cents: 8400, tickets_opened: 1, referrals_qualified: 0 });
    expect(await day('2001-03-09')).toMatchObject({ new_accounts: 1, revenue_cents: 0 });
    await metrics.refreshMetrics('2001-03-09', '2001-03-10'); // same result, no duplicate rows
    expect(await day('2001-03-10')).toEqual(first);
    const [{ n }] = (await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from admin_metrics_daily where day between '2001-02-20' and '2001-03-12'`)) as unknown as [{ n: number }];
    expect(n).toBe(21);
    expect(await metrics.refreshRecentMetrics(at('2001-03-11T12:00:00Z'))).toBe(2); // the hourly job: yesterday + today
  });

  it('overview: period sums, delta vs previous period, buckets, live counters and latest lists', async () => {
    await metrics.refreshMetrics('2001-02-20', '2001-03-12');
    const o = adminOverviewSchema.parse(await mod.getOverview(7, at('2001-03-10T20:00:00Z')));
    expect(o.growth).toHaveLength(7);
    expect(o.growth.at(-1)).toEqual({ day: '2001-03-10', accounts: 1, maps: 1 });
    expect(o.growth.at(-2)).toEqual({ day: '2001-03-09', accounts: 1, maps: 0 });
    expect(o.kpis.revenue).toMatchObject({ value: 8400, delta: 8400 - 1000 });
    expect(o.kpis.revenue.deltaPct).toBe(740); // 7400 / previous 1000
    expect(o.kpis.revenue.spark).toHaveLength(7);
    expect(o.kpis.referralsQualified.deltaPct).toBeNull(); // base 0
    expect(o.latestPayments.every((p) => ['pix', 'card', 'credit'].includes(p.method))).toBe(true);
    expect(o.latestUsers.every((u) => ['direct', 'referral'].includes(u.origin))).toBe(true);
    expect(o.kpis.accounts.delta).toBe(2); // added in the period (live value is global)
    expect(o.kpis.openTickets.delta).toBe(1);
    expect(o.kpis.proSubscribers.delta).toBe(1);
    expect(o.latestPayments.length).toBeLessThanOrEqual(5);
    expect(o.latestUsers.length).toBeLessThanOrEqual(5);
    const o90 = await mod.getOverview(90, at('2001-03-10T20:00:00Z'));
    expect(o90.growth).toHaveLength(30); // 3-day buckets
    expect(o90.growth.at(-1)).toEqual({ day: '2001-03-08', accounts: 2, maps: 1 });
    expect(o90.kpis.revenue.value).toBe(9400);
  });

  it('GET /overview validates the period; export rows are the daily aggregates', async () => {
    const r = await app.request('/overview?period=30');
    expect(r.status).toBe(200);
    expect(adminOverviewSchema.parse(((await r.json()) as { data: unknown }).data).growth).toHaveLength(30);
    expect((await app.request('/overview?period=5')).status).toBe(422);
    const exp = core.getExport('overview')!;
    const out = await dbm.db.transaction((tx) => exp({ period: '7' }, tx));
    expect(out.ok && out.data.rows).toHaveLength(7);
    expect((await dbm.db.transaction((tx) => exp({ period: 'x' }, tx))).ok).toBe(false);
  });
});
