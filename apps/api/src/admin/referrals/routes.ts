// F19 FR-17 (D-462): /v1/admin/referrals. `in_review` = rejected by velocity_limit/fraud_signals (D-381). approve = qualify + both grants in the
// withAdmin transaction (F18 grantBothSides, idempotent by the (referral, user) unique index); reject = final, no grants; revoke-grant = one grant.
import { Hono, type Context } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import {
  adminErrors, adminReferralListQuerySchema, err, ok, parseWith, revokeGrantInputSchema, type AdminReferralDetail, type AdminReferralPage, type AdminReferralRow, type Result,
} from '@remoa/contracts';
import { applyPendingCredits } from '../../billing/credits';
import { lockGrants } from '../../billing/grants';
import { dbm } from '../../db';
import { grantBothSides } from '../../referral/grant';
import { notifyRewardGranted } from '../../referral/notify';
import { notFound, reasonOf, registerExport, send, withAdmin, type AdminEnv } from '../core';
import { dt, dtReq, isUuid, likeOf, trailOf } from '../users/util';
import { invalidate } from '../../cache';

const conflict = () => err<never>('conflict', adminErrors.invalidState);
type Raw = Record<string, unknown>;
type C = Context<AdminEnv>;

const cols = sql`r.id, r.referrer_id, r.referee_id, r.invited_email_masked, r.channel::text as channel, r.reject_reason::text as reject_reason, r.created_at, r.signed_up_at, r.qualified_at,
  case when r.status = 'rejected' and r.reject_reason in ('velocity_limit', 'fraud_signals') then 'in_review' else r.status::text end as status,
  pa.name as referrer_name, ua.email as referrer_email, pb.name as referee_name, ub.email as referee_email`;
const from = sql`from referrals r left join profiles pa on pa.user_id = r.referrer_id left join auth.users ua on ua.id = r.referrer_id
  left join profiles pb on pb.user_id = r.referee_id left join auth.users ub on ub.id = r.referee_id`;
const months = sql`(select count(*)::int from entitlement_grants g where g.referral_id = y.id and g.revoked_at is null) as reward_months`;
const ref = (id: unknown, name: unknown, email: unknown) => (id ? { id: id as string, name: (name as string | null) ?? null, email: (email as string | null) ?? null } : null);
const rowOf = (r: Raw): AdminReferralRow => ({
  id: r.id as string, referrer: ref(r.referrer_id, r.referrer_name, r.referrer_email), referee: ref(r.referee_id, r.referee_name, r.referee_email),
  invitedEmailMasked: (r.invited_email_masked as string | null) ?? null, channel: r.channel as AdminReferralRow['channel'], status: r.status as AdminReferralRow['status'],
  fraudSignals: r.reject_reason && r.reject_reason !== 'manual' ? [r.reject_reason as AdminReferralRow['fraudSignals'][number]] : [],
  rewardMonths: Number(r.reward_months ?? 0), createdAt: dtReq(r.created_at),
});

async function listReferrals(input: unknown, all?: number): Promise<Result<AdminReferralPage>> {
  const q = parseWith(adminReferralListQuerySchema, input);
  if (!q.ok) return q;
  const { db } = await dbm();
  const w: SQL[] = [];
  if (q.data.channel) w.push(sql`r.channel = ${q.data.channel}`);
  if (q.data.q) {
    const l = likeOf(q.data.q);
    w.push(sql`(pa.name ilike ${l} or ua.email ilike ${l} or pb.name ilike ${l} or ub.email ilike ${l})`);
  }
  const where = w.length ? sql`where ${sql.join(w, sql` and `)}` : sql``;
  const filter = q.data.status ? sql`where status = ${q.data.status}` : sql``;
  const { page, pageSize } = q.data;
  const limit = all ?? pageSize;
  const offset = all ? 0 : (page - 1) * pageSize;
  const [rows, [t], [s]] = await Promise.all([
    db.execute(sql`with x as (select ${cols} ${from} ${where}) select y.*, ${months} from (select * from x ${filter} order by created_at desc, id limit ${limit} offset ${offset}) y`),
    db.execute<{ n: number }>(sql`with x as (select ${cols} ${from} ${where}) select count(*)::int as n from x ${filter}`),
    db.execute<{ qualified: number; in_progress: number; in_review: number; rejected: number; months: number }>(sql`
      with x as (select ${cols} ${from}) select
        (count(*) filter (where status = 'qualified'))::int as qualified, (count(*) filter (where status in ('invited', 'signed_up')))::int as in_progress,
        (count(*) filter (where status = 'in_review'))::int as in_review, (count(*) filter (where status = 'rejected'))::int as rejected,
        ((select count(*) from entitlement_grants where referral_id is not null and revoked_at is null) + (select count(*) from billing_credits where referral_id is not null))::int as months from x`),
  ]);
  return ok({
    items: [...rows].map((r) => rowOf(r as Raw)), total: t?.n ?? 0, page, pageSize,
    summary: { qualified: s?.qualified ?? 0, inProgress: s?.in_progress ?? 0, inReview: s?.in_review ?? 0, rejected: s?.rejected ?? 0, monthsGranted: s?.months ?? 0 },
  });
}

// ponytail: one CSV in memory, capped; stream it if exports ever need more rows.
const EXPORT_MAX_ROWS = 10_000;
registerExport('referrals', async (filters) => {
  const q = parseWith(adminReferralListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const r = await listReferrals(q.data, EXPORT_MAX_ROWS);
  if (!r.ok) return r;
  return ok({
    header: ['id', 'indicador', 'email_indicador', 'indicado', 'email_indicado', 'canal', 'status', 'sinais', 'meses', 'criado_em'],
    rows: r.data.items.map((i) => [i.id, i.referrer?.name, i.referrer?.email, i.referee?.name, i.referee?.email, i.channel, i.status, i.fraudSignals.join(' '), i.rewardMonths, i.createdAt]),
  });
});

async function referralOf(id: string) {
  if (!isUuid(id)) return null;
  const { db } = await dbm();
  const [r] = await db.execute(sql`with y as (select ${cols} ${from} where r.id = ${id}) select y.*, ${months} from y`);
  return (r as Raw | undefined) ?? null;
}

/** Locks the referral row; the state check below runs on this fresh copy, so two concurrent actions can't both pass. */
const lockRow = async (tx: Parameters<Parameters<typeof withAdmin>[3]>[0], id: string) =>
  (await tx.execute<{ id: string; referrer_id: string; referee_id: string | null; status: string; reject_reason: string | null }>(
    sql`select id, referrer_id, referee_id, status::text as status, reject_reason::text as reject_reason from referrals where id = ${id} for update`))[0];

export const referralsRoutes = new Hono<AdminEnv>()
  .get('/', async (c) => send(await listReferrals(c.req.query())))
  .get('/:id', async (c) => {
    const r = await referralOf(c.req.param('id'));
    if (!r) return notFound();
    const { db } = await dbm();
    const grants = await db.execute(sql`select id, user_id, starts_at, ends_at, revoked_at from entitlement_grants where referral_id = ${r.id as string} order by created_at, id`);
    const detail: AdminReferralDetail = {
      ...rowOf(r), signedUpAt: dt(r.signed_up_at), qualifiedAt: dt(r.qualified_at),
      grants: [...grants].map((g) => ({ id: g.id as string, userId: g.user_id as string, startsAt: dtReq(g.starts_at), endsAt: dtReq(g.ends_at), revokedAt: dt(g.revoked_at) })),
      audit: await trailOf([['referral', r.id as string], ...[...grants].map((g) => ['grant', g.id as string] as ['grant', string])]),
    };
    return send(ok(detail));
  })
  // rejected/in_review → qualified. A grant already revoked is NOT re-granted: the unique index returns the existing (revoked) row, `created` is false (D-462).
  .post('/:id/approve', async (c: C) => {
    const json: unknown = await c.req.json().catch(() => null);
    const id = c.req.param('id') ?? '';
    if (!(await referralOf(id))) return notFound();
    let granted: Awaited<ReturnType<typeof grantBothSides>> = [];
    let sides: (string | null)[] = [];
    const r = await withAdmin(c, 'referral.approve', { reason: reasonOf(json), target: { type: 'referral', id } }, async (tx, audit) => {
      const row = await lockRow(tx, id);
      if (!row || row.status !== 'rejected' || !row.referee_id) return conflict();
      sides = [row.referrer_id, row.referee_id];
      audit.before({ status: row.status, rejectReason: row.reject_reason });
      await tx.execute(sql`update referrals set status = 'qualified', reject_reason = null, qualified_at = now() where id = ${id}`);
      granted = await grantBothSides(tx, { id, referrerId: row.referrer_id, refereeId: row.referee_id });
      audit.after({ status: 'qualified', granted });
      return ok({ granted });
    });
    if (r.ok) {
      for (const u of sides) await invalidate('referral.changed', { userId: u! }); // after COMMIT: grants + referral summary of both sides
      for (const g of granted) if (g.kind === 'credit') await applyPendingCredits(g.userId).catch(() => null); // Stripe only after commit; the sweep retries
      await notifyRewardGranted(id); // never throws
    }
    return send(r);
  })
  // signed_up or in_review → rejected (final, reason 'manual'); never touches grants (qualified ones are revoked one by one).
  .post('/:id/reject', async (c: C) => {
    const json: unknown = await c.req.json().catch(() => null);
    const id = c.req.param('id') ?? '';
    if (!(await referralOf(id))) return notFound();
    let sides: (string | null)[] = [];
    const r = await withAdmin(c, 'referral.reject', { reason: reasonOf(json), target: { type: 'referral', id } }, async (tx, audit) => {
      const row = await lockRow(tx, id);
      sides = [row?.referrer_id ?? null, row?.referee_id ?? null];
      const reviewing = row?.status === 'rejected' && (row.reject_reason === 'velocity_limit' || row.reject_reason === 'fraud_signals');
      if (!row || (row.status !== 'signed_up' && !reviewing)) return conflict();
      audit.before({ status: row.status, rejectReason: row.reject_reason });
      await tx.execute(sql`update referrals set status = 'rejected', reject_reason = 'manual' where id = ${id}`);
      audit.after({ status: 'rejected', rejectReason: 'manual' });
      return ok({});
    });
    if (r.ok) for (const u of sides) if (u) await invalidate('referral.changed', { userId: u });
    return send(r);
  })
  .post('/:id/revoke-grant', async (c: C) => {
    const json: unknown = await c.req.json().catch(() => null);
    const id = c.req.param('id') ?? '';
    const body = parseWith(revokeGrantInputSchema.omit({ reason: true }), json);
    if (!body.ok) return send(body);
    if (!(await referralOf(id))) return notFound();
    const { grantId } = body.data;
    let owner: string | null = null;
    const r = await withAdmin(c, 'grant.revoke', { reason: reasonOf(json), target: { type: 'grant', id: grantId } }, async (tx, audit) => {
      const { entitlementGrants: g } = await dbm();
      const [x] = await tx.execute<{ user_id: string; revoked_at: string | null }>(sql`select user_id, revoked_at from entitlement_grants where id = ${grantId} and referral_id = ${id}`);
      owner = x?.user_id ?? null;
      if (!x || x.revoked_at) return conflict(); // unknown to this referral, already revoked or converted (F18)
      await lockGrants(tx, x.user_id);
      audit.before({ referralId: id, revoked: false });
      const rows = await tx.update(g).set({ revokedAt: new Date(), revokedReason: 'manual' }).where(sql`${g.id} = ${grantId} and ${g.revokedAt} is null`).returning({ id: g.id });
      if (!rows.length) return conflict();
      audit.after({ referralId: id, revoked: true, revokedReason: 'manual' });
      return ok({});
    });
    if (r.ok && owner) await invalidate('grant.changed', { userId: owner });
    return send(r);
  });
