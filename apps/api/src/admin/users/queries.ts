// F19 FR-14: user list, summary and drawer. Search and filters run in SQL (FR-22); plan mirrors billing/plan.ts `planOf` (subscription or running grant).
import { sql, type SQL } from 'drizzle-orm';
import { PRO_GRACE_DAYS, RETENTION, type AdminUserDetail, type AdminUserListQuery, type AdminUserPage, type AdminUserRow, adminUserListQuerySchema } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { dt, dtReq, likeOf, trailOf } from './util';

const planSql = sql`case
  when s.plan = 'founder' then 'founder'
  when (s.plan = 'pro' and (
      (s.status in ('active', 'trialing') and not (s.stripe_subscription_id is null and s.renews_at is not null and now() >= s.renews_at))
      or (s.status = 'past_due' and s.renews_at is not null and now() < s.renews_at + make_interval(days => ${PRO_GRACE_DAYS}))
      or (s.cancel_at_period_end and s.renews_at is not null and now() < s.renews_at)))
    or exists (select 1 from entitlement_grants g where g.user_id = p.user_id and g.revoked_at is null and g.starts_at <= now() and g.ends_at > now())
  then 'pro' else 'free' end`;
const statusSql = sql`case when p.deleted_at is not null then 'deleting' when p.suspended_at is not null then 'suspended' when u.email_confirmed_at is null then 'pending' else 'active' end`;
const cols = sql`p.user_id as id, p.name, u.email, ${planSql} as plan, ${statusSql} as status,
  case when p.referred_by is null then 'direct' else 'referral' end as origin, p.created_at,
  p.role, u.email_confirmed_at, u.last_sign_in_at, p.suspended_at, p.suspended_reason, p.deleted_at,
  (select max(g.ends_at) from entitlement_grants g where g.user_id = p.user_id and g.revoked_at is null and g.ends_at > now()) as grant_until`;
const from = sql`from profiles p join auth.users u on u.id = p.user_id left join subscriptions s on s.user_id = p.user_id`;
const counts = (a: string) => sql`(select count(*)::int from boards b where b.user_id = ${sql.raw(a)}.id and b.archived_at is null and b.status = 'private') as maps,
  (select count(*)::int from cards c join boards b on b.id = c.board_id where b.user_id = ${sql.raw(a)}.id and c.deleted_at is null) as cards`;

type Raw = Record<string, unknown>;
const rowOf = (r: Raw): AdminUserRow => ({
  id: r.id as string, name: (r.name as string | null) ?? null, email: (r.email as string | null) ?? null, plan: r.plan as AdminUserRow['plan'],
  maps: Number(r.maps ?? 0), cards: Number(r.cards ?? 0), status: r.status as AdminUserRow['status'], origin: r.origin as AdminUserRow['origin'], createdAt: dtReq(r.created_at), grantUntil: dt(r.grant_until),
});

/** `q` = name or e-mail; `plan`/`status` filters; the summary counts every account matching `q` (chips stay stable while filtering). */
export async function listUsers(input: AdminUserListQuery, tx?: Tx, opts?: { all?: number }): Promise<AdminUserPage> {
  const q = adminUserListQuerySchema.parse(input);
  const { db } = await dbm();
  const conn = tx ?? db;
  const search: SQL = q.q ? sql`where (p.name ilike ${likeOf(q.q)} or u.email ilike ${likeOf(q.q)})` : sql``;
  const f: SQL[] = [];
  if (q.plan === 'pro_grant') f.push(sql`x.grant_until is not null`); // CCR-014: Pro por indicação
  else if (q.plan) f.push(sql`x.plan = ${q.plan}`);
  if (q.status) f.push(sql`x.status = ${q.status}`);
  const filter = f.length ? sql`where ${sql.join(f, sql` and `)}` : sql``;
  const limit = opts?.all ?? q.pageSize;
  const offset = opts?.all ? 0 : (q.page - 1) * q.pageSize;
  const [rows, [t]] = await Promise.all([
    conn.execute(sql`with x as (select ${cols} ${from} ${search})
      select y.*, ${counts('y')} from (select * from x ${filter} order by created_at desc, id limit ${limit} offset ${offset}) y`),
    conn.execute<{ total: number; filtered: number; active: number; pending: number; suspended: number }>(sql`with x as (select ${cols} ${from} ${search})
      select count(*)::int as total, (count(*) ${f.length ? sql`filter (where ${sql.join(f, sql` and `)})` : sql``})::int as filtered,
        (count(*) filter (where status = 'active'))::int as active, (count(*) filter (where status = 'pending'))::int as pending,
        (count(*) filter (where status = 'suspended'))::int as suspended from x`),
  ]);
  return {
    items: [...rows].map((r) => rowOf(r as Raw)), total: t?.filtered ?? 0, page: q.page, pageSize: q.pageSize,
    summary: { total: t?.total ?? 0, active: t?.active ?? 0, pending: t?.pending ?? 0, suspended: t?.suspended ?? 0 },
  };
}

export async function getUser(id: string): Promise<AdminUserDetail | null> {
  const { db } = await dbm();
  const [r] = await db.execute(sql`with x as (select ${cols} ${from} where p.user_id = ${id}) select x.*, ${counts('x')} from x`);
  if (!r) return null;
  const d = r as Raw;
  const deletedAt = dt(d.deleted_at);
  return {
    ...rowOf(d), role: d.role as AdminUserDetail['role'], emailConfirmedAt: dt(d.email_confirmed_at), lastSignInAt: dt(d.last_sign_in_at),
    suspendedAt: dt(d.suspended_at), suspendedReason: (d.suspended_reason as string | null) ?? null,
    deletionAt: deletedAt && new Date(deletedAt.getTime() + RETENTION.deletionGraceDays * 86_400_000), grantUntil: dt(d.grant_until),
    timeline: await trailOf([['user', id]]),
  };
}
