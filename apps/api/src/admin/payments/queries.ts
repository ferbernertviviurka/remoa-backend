// F19 FR-16, FR-22: payments list (search, filters, summary) and drawer. Server connection; admins only (routes/admin.ts).
import { sql, type SQL } from 'drizzle-orm';
import { adminPaymentListQuerySchema, type AdminPaymentDetail, type AdminPaymentListQuery, type AdminPaymentPage, type AdminPaymentRow } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { dt, dtReq, likeOf, trailOf } from '../users/util';

/** Optional `period` (days) is not in AdminPaymentListQuery: read from the raw query (7|30|90), ignored otherwise. */
export const periodOf = (raw: Record<string, string | undefined>) => (['7', '30', '90'].includes(raw.period ?? '') ? Number(raw.period) : null);

const cols = sql`p.id, p.user_id, pr.name, u.email, p.item, p.method, p.coupon, p.status, p.amount_cents, p.currency, p.created_at,
  p.stripe_customer_id, p.stripe_subscription_id, p.stripe_payment_intent, p.stripe_invoice_id, p.refunded_at, p.events`;
const from = sql`from payments p left join profiles pr on pr.user_id = p.user_id left join auth.users u on u.id = p.user_id`;

type Raw = Record<string, unknown>;
const rowOf = (r: Raw): AdminPaymentRow => ({
  id: r.id as string,
  user: r.user_id ? { id: r.user_id as string, name: (r.name as string | null) ?? null, email: (r.email as string | null) ?? null } : null,
  item: r.item as AdminPaymentRow['item'], method: r.method as AdminPaymentRow['method'], coupon: (r.coupon as string | null) ?? null,
  status: r.status as AdminPaymentRow['status'], amountCents: Number(r.amount_cents), currency: r.currency as string, createdAt: dtReq(r.created_at),
});

/** `q` = payment id (prefix), e-mail or name. The summary ignores the status filter (the chips stay put while filtering by status). */
export async function listPayments(input: AdminPaymentListQuery, opts: { period?: number | null; all?: number; tx?: Tx } = {}): Promise<AdminPaymentPage> {
  const q = adminPaymentListQuerySchema.parse(input);
  const { db } = await dbm();
  const conn = opts.tx ?? db;
  const base: SQL[] = [];
  if (q.q) base.push(sql`(p.id like ${`${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} or u.email ilike ${likeOf(q.q)} or pr.name ilike ${likeOf(q.q)})`);
  if (q.method) base.push(sql`p.method = ${q.method}`);
  if (opts.period) base.push(sql`p.created_at >= now() - make_interval(days => ${opts.period})`);
  const where = (extra: SQL[]) => (extra.length ? sql`where ${sql.join(extra, sql` and `)}` : sql``);
  const filtered = q.status ? [...base, sql`p.status = ${q.status}`] : base;
  const limit = opts.all ?? q.pageSize;
  const offset = opts.all ? 0 : (q.page - 1) * q.pageSize;
  const [rows, [s]] = await Promise.all([
    conn.execute(sql`select ${cols} ${from} ${where(filtered)} order by p.created_at desc, p.id limit ${limit} offset ${offset}`),
    conn.execute<{ received: string | null; paid: number; pending: number; failed: number; refunded: number; filtered: number }>(sql`select
      sum(p.amount_cents) filter (where p.status = 'paid') as received,
      (count(*) filter (where p.status = 'paid'))::int as paid, (count(*) filter (where p.status = 'pending'))::int as pending,
      (count(*) filter (where p.status = 'failed'))::int as failed, (count(*) filter (where p.status = 'refunded'))::int as refunded,
      (count(*) ${q.status ? sql`filter (where p.status = ${q.status})` : sql``})::int as filtered
      ${from} ${where(base)}`),
  ]);
  return {
    items: [...rows].map((r) => rowOf(r as Raw)), total: s?.filtered ?? 0, page: q.page, pageSize: q.pageSize,
    summary: { receivedCents: Number(s?.received ?? 0), paid: s?.paid ?? 0, pending: s?.pending ?? 0, failed: s?.failed ?? 0, refunded: s?.refunded ?? 0 },
  };
}

export async function getPayment(id: string): Promise<AdminPaymentDetail | null> {
  const { db } = await dbm();
  const [r] = await db.execute(sql`select ${cols} ${from} where p.id = ${id}`);
  if (!r) return null;
  const d = r as Raw;
  return {
    ...rowOf(d),
    stripeCustomerId: (d.stripe_customer_id as string | null) ?? null, stripeSubscriptionId: (d.stripe_subscription_id as string | null) ?? null,
    stripePaymentIntent: (d.stripe_payment_intent as string | null) ?? null, stripeInvoiceId: (d.stripe_invoice_id as string | null) ?? null,
    refundedAt: dt(d.refunded_at),
    timeline: ((d.events as { type: AdminPaymentDetail['timeline'][number]['type']; at: string }[]) ?? []).map((e) => ({ type: e.type, at: new Date(e.at) })),
    audit: await trailOf([['payment', id]]),
  };
}
