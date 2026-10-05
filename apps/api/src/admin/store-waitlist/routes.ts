// CCR-030 / D-656: GET /v1/admin/store-waitlist (counts only) + export `store_waitlist`. Rule 9: withAdmin, audited, 404 for non-admin.
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { ADMIN_AUTO_REASONS, adminStoreWaitlistExportFiltersSchema, ok, parseWith, type AdminStoreWaitlistSummary, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { registerExport, send, withAdmin, type AdminEnv } from '../core';

async function summary(tx: Tx): Promise<AdminStoreWaitlistSummary> {
  const [r] = await tx.execute<{ total: number; buy: number; sell: number; both: number; teacher: number; student_resident: number; physician: number }>(sql`
    select count(*)::int as total,
      count(*) filter (where wants_buy)::int as buy,
      count(*) filter (where wants_sell)::int as sell,
      count(*) filter (where wants_buy and wants_sell)::int as both,
      count(*) filter (where seller_role = 'teacher')::int as teacher,
      count(*) filter (where seller_role = 'student_resident')::int as student_resident,
      count(*) filter (where seller_role = 'physician')::int as physician
    from store_waitlist`);
  const n = r ?? { total: 0, buy: 0, sell: 0, both: 0, teacher: 0, student_resident: 0, physician: 0 };
  return { total: n.total, buy: n.buy, sell: n.sell, both: n.both, byRole: { teacher: n.teacher, student_resident: n.student_resident, physician: n.physician } };
}

// ponytail: one CSV in memory, capped; stream it if exports ever need more rows.
const EXPORT_MAX_ROWS = 10_000;
registerExport('store_waitlist', async (filters, tx) => {
  const f = parseWith(adminStoreWaitlistExportFiltersSchema, filters);
  if (!f.ok) return f;
  const w = [f.data.interest === 'buy' ? sql`wants_buy` : f.data.interest === 'sell' ? sql`wants_sell` : sql`true`, f.data.role ? sql`seller_role = ${f.data.role}` : sql`true`];
  const rows = await tx.execute(sql`select email, wants_buy, wants_sell, seller_role, consented_at, created_at from store_waitlist where ${sql.join(w, sql` and `)} order by created_at desc, user_id limit ${EXPORT_MAX_ROWS}`);
  return ok({
    header: ['email', 'comprar', 'vender', 'perfil', 'consentimento_em', 'criado_em'],
    rows: [...rows].map((r) => [r.email as string, r.wants_buy as boolean, r.wants_sell as boolean, r.seller_role as string | null, r.consented_at as Date, r.created_at as Date]),
  });
});

export const storeWaitlistRoutes = new Hono<AdminEnv>().get('/', async (c) => {
  const r: Result<AdminStoreWaitlistSummary & { audit: unknown }> = await withAdmin(
    c, 'store_waitlist.view', { reason: ADMIN_AUTO_REASONS.storeWaitlistView, target: { type: 'route', id: '/v1/admin/store-waitlist' }, sensitive: false },
    async (tx, audit) => {
      const s = await summary(tx);
      audit.after({ total: s.total });
      return ok(s);
    },
  );
  if (!r.ok) return send(r);
  const { audit: _audit, ...data } = r.data;
  void _audit;
  return send(ok(data));
});
