// F19 FR-13, FR-22 (D-458): admin_metrics_daily. One row per São Paulo day, recomputed from the source tables by an
// idempotent upsert: the hourly maintenance run refreshes yesterday + today; any range can be backfilled the same way:
//   pnpm --filter @remoa/api exec tsx --env-file=../../.env -e "import('./src/admin/overview/metrics.ts').then(m => m.refreshMetrics('2026-01-01', '2026-10-04'))"
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';

export const TZ = 'America/Sao_Paulo';
/** YYYY-MM-DD of `d` in São Paulo. */
export const spDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });
/** `day` ± n days (calendar arithmetic on the date string, no time zone involved). */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Recompute [from, to] (inclusive, YYYY-MM-DD). Counts: accounts = profiles created; maps = student boards created
 * (archived included); new_pro = users whose first paid payment is that day; revenue = paid payments created that day
 * (refunded ones leave the day when it is recomputed); referrals = qualified that day; tickets = opened that day.
 */
export async function refreshMetrics(from: string, to: string, tx?: Tx) {
  const conn = tx ?? (await dbm()).db;
  const rows = await conn.execute<{ day: string }>(sql`
    insert into admin_metrics_daily (day, new_accounts, new_maps, new_pro, revenue_cents, referrals_qualified, tickets_opened, updated_at)
    select d.day,
      (select count(*) from profiles where created_at >= b.lo and created_at < b.hi),
      (select count(*) from boards where status = 'private' and created_at >= b.lo and created_at < b.hi),
      (select count(distinct p.user_id) from payments p where p.status = 'paid' and p.created_at >= b.lo and p.created_at < b.hi
        and not exists (select 1 from payments q where q.user_id = p.user_id and q.status = 'paid' and q.created_at < p.created_at)),
      (select coalesce(sum(amount_cents), 0) from payments where status = 'paid' and created_at >= b.lo and created_at < b.hi),
      (select count(*) from referrals where status = 'qualified' and qualified_at >= b.lo and qualified_at < b.hi),
      (select count(*) from support_tickets where created_at >= b.lo and created_at < b.hi),
      now()
    from (select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day) d
    cross join lateral (select d.day::timestamp at time zone ${TZ} as lo, (d.day + 1)::timestamp at time zone ${TZ} as hi) b
    on conflict (day) do update set new_accounts = excluded.new_accounts, new_maps = excluded.new_maps, new_pro = excluded.new_pro,
      revenue_cents = excluded.revenue_cents, referrals_qualified = excluded.referrals_qualified, tickets_opened = excluded.tickets_opened, updated_at = now()
    returning day`);
  return rows.length;
}

/** Hourly job (account/maintenance.ts): yesterday catches the events that landed after its last run. */
export const refreshRecentMetrics = (now = new Date()) => refreshMetrics(addDays(spDay(now), -1), spDay(now));
