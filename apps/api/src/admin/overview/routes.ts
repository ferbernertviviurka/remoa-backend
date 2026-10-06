// F19 FR-13 (D-458): GET /v1/admin/overview?period=7|30|90. Period figures come from admin_metrics_daily (refreshed hourly);
// the four "Total"/live numbers, attention counters and latest rows are bounded queries on indexed columns.
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { ADMIN_LIMITS, ok, overviewQuerySchema, parseWith, PRO_GRACE_DAYS, type AdminOverview, type Kpi, type OverviewPeriod } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { registerExport, send, type AdminEnv } from '../core';
import { dtReq } from '../users/util';
import { listUsers } from '../users/queries';
import { addDays, spDay } from './metrics';

const KEYS = ['new_accounts', 'new_maps', 'new_pro', 'revenue_cents', 'referrals_qualified', 'tickets_opened'] as const;
type Key = (typeof KEYS)[number];
type Day = Record<Key, number> & { day: string };

/** Daily rows of [period start − period, today], missing days as zeros; buckets of 1 day (7/30) or 3 days (90). */
const seriesSql = (period: OverviewPeriod, now: Date) => {
  const today = spDay(now);
  return sql`select day::text as day, ${sql.raw(KEYS.join(', '))} from admin_metrics_daily where day >= ${addDays(addDays(today, -(period - 1)), -period)}::date and day <= ${today}::date`;
};
async function series(period: OverviewPeriod, now: Date, tx?: Tx) {
  const conn = tx ?? (await dbm()).db;
  return seriesOf(period, now, await conn.execute<Record<string, unknown>>(seriesSql(period, now)));
}
function seriesOf(period: OverviewPeriod, now: Date, rows: Iterable<Record<string, unknown>>) {
  const start = addDays(spDay(now), -(period - 1));
  const byDay = new Map([...rows].map((r) => [r.day as string, r]));
  const day = (d: string): Day => ({ day: d, ...Object.fromEntries(KEYS.map((k) => [k, Number(byDay.get(d)?.[k] ?? 0)])) } as Day);
  const cur = Array.from({ length: period }, (_, i) => day(addDays(start, i)));
  const prev = Array.from({ length: period }, (_, i) => day(addDays(start, i - period)));
  const size = period === 90 ? 3 : 1;
  const buckets = Array.from({ length: period / size }, (_, b) => cur.slice(b * size, (b + 1) * size));
  const sum = (days: Day[], k: Key) => days.reduce((a, d) => a + d[k], 0);
  return { cur, prev, buckets, sum, spark: (k: Key) => buckets.map((b) => sum(b, k)) };
}

/** Subscription gives paid Pro/Founder (billing/plan.ts subscriptionPro + D-375); referral grants are not subscribers. */
const PAYING = sql`(plan = 'founder' or (plan = 'pro' and (
  (status in ('active', 'trialing') and not (stripe_subscription_id is null and renews_at is not null and now() >= renews_at))
  or (status = 'past_due' and renews_at is not null and now() < renews_at + make_interval(days => ${PRO_GRACE_DAYS}))
  or (cancel_at_period_end and renews_at is not null and now() < renews_at))))`;

type Row = Record<string, unknown>;
type Live = { accounts: number; maps_total: number; pro: number; tickets: number; referrals_in_review: number; failed_24h: number; tickets_stale: number; seeds: number; series: Row[]; payments: Row[]; maps: Row[] };

export async function getOverview(period: OverviewPeriod, now = new Date()): Promise<AdminOverview> {
  const { db } = await dbm();
  const n = ADMIN_LIMITS.overviewListSize;
  // G21 P-482 (D-1048): the period rows, the live counters and both "latest" lists in ONE statement (was 4); listUsers keeps its own.
  const [[live], users] = await Promise.all([
    db.execute<Live>(sql`select
      (select count(*)::int from profiles where deleted_at is null) as accounts,
      (select count(*)::int from boards where status = 'private' and archived_at is null) as maps_total,
      (select count(*)::int from subscriptions where ${PAYING}) as pro,
      (select count(*)::int from support_tickets where status in ('open', 'in_review')) as tickets,
      (select count(*)::int from referrals where status = 'rejected' and reject_reason in ('velocity_limit', 'fraud_signals')) as referrals_in_review,
      (select count(*)::int from payments where status = 'failed' and updated_at > now() - interval '24 hours') as failed_24h,
      (select count(*)::int from support_tickets where status in ('open', 'in_review')
        and last_user_message_at < now() - make_interval(hours => ${ADMIN_LIMITS.ticketStaleHours})
        and (last_admin_reply_at is null or last_admin_reply_at < last_user_message_at)) as tickets_stale,
      (select count(*)::int from boards where status = 'seed_draft' and archived_at is null) as seeds,
      (select coalesce(json_agg(t), '[]') from (${seriesSql(period, now)}) t) as series,
      (select coalesce(json_agg(t order by t.created_at desc), '[]') from (select p.id, p.user_id, pr.name, u.email, p.item, p.method, p.amount_cents, p.status, p.created_at from payments p
        left join profiles pr on pr.user_id = p.user_id left join auth.users u on u.id = p.user_id order by p.created_at desc limit ${n}) t) as payments,
      (select coalesce(json_agg(t order by t.created_at desc), '[]') from (select b.id, b.title, b.user_id, pr.name, u.email, b.created_at, b.area::text as area,
        (select count(*)::int from cards c where c.board_id = b.id and c.deleted_at is null) as cards
        from (select * from boards where status = 'private' order by created_at desc limit ${n}) b
        left join profiles pr on pr.user_id = b.user_id left join auth.users u on u.id = b.user_id) t) as maps`),
    listUsers({ pageSize: n }),
  ]);
  const l = live!;
  const s = seriesOf(period, now, l.series);
  const { payments, maps } = l;
  const kpi = (value: number, delta: number, base: number, spark: number[]): Kpi => ({ value, delta, deltaPct: base > 0 ? Math.round((delta / base) * 100) : null, spark });
  const flow = (k: Key): Kpi => kpi(s.sum(s.cur, k), s.sum(s.cur, k) - s.sum(s.prev, k), s.sum(s.prev, k), s.spark(k));
  // Totals: value now, delta = growth in the period (what was added; churn is not in the daily table).
  const total = (value: number, k: Key): Kpi => kpi(value, s.sum(s.cur, k), value - s.sum(s.cur, k), s.spark(k));
  const ref = (r: Record<string, unknown>) => (r.user_id ? { id: r.user_id as string, name: (r.name as string | null) ?? null, email: (r.email as string | null) ?? null } : null);
  return {
    period,
    kpis: {
      accounts: total(l.accounts, 'new_accounts'),
      maps: total(l.maps_total, 'new_maps'),
      proSubscribers: total(l.pro, 'new_pro'),
      revenue: flow('revenue_cents'),
      referralsQualified: flow('referrals_qualified'),
      // Live count; delta = tickets opened in the period vs the previous one.
      openTickets: { ...flow('tickets_opened'), value: l.tickets },
    },
    growth: s.buckets.map((b) => ({ day: b[0]!.day, accounts: s.sum(b, 'new_accounts'), maps: s.sum(b, 'new_maps') })),
    attention: { referralsInReview: l.referrals_in_review, paymentsFailed24h: l.failed_24h, ticketsStale: l.tickets_stale, seedsAwaitingReview: l.seeds },
    latestPayments: [...payments].map((r) => ({ id: r.id as string, user: ref(r), item: r.item as AdminOverview['latestPayments'][number]['item'], method: r.method as AdminOverview['latestPayments'][number]['method'], amountCents: Number(r.amount_cents), status: r.status as AdminOverview['latestPayments'][number]['status'], createdAt: dtReq(r.created_at) })),
    latestUsers: users.items.map((u) => ({ user: { id: u.id, name: u.name, email: u.email }, plan: u.plan, origin: u.origin, createdAt: u.createdAt })),
    latestMaps: [...maps].map((r) => ({ id: r.id as string, title: r.title as string, owner: ref(r), area: r.area as AdminOverview['latestMaps'][number]['area'], cards: Number(r.cards), createdAt: dtReq(r.created_at) })),
    generatedAt: now,
  };
}

registerExport('overview', async (filters, tx) => {
  const q = parseWith(overviewQuerySchema, filters);
  if (!q.ok) return q;
  const s = await series(q.data.period, new Date(), tx);
  return ok({
    header: ['dia', 'novas_contas', 'novos_mapas', 'novos_pro', 'receita_centavos', 'indicacoes_qualificadas', 'chamados_abertos'],
    rows: s.cur.map((d) => [d.day, ...KEYS.map((k) => d[k])]),
  });
});

export const overviewRoutes = new Hono<AdminEnv>().get('/', async (c) => {
  const q = parseWith(overviewQuerySchema, c.req.query());
  return send(q.ok ? ok(await getOverview(q.data.period)) : q);
});
