// CCR-020 / D-578: GET /v1/admin/waitlist. E-mails are PII: every list call writes one `waitlist.view` audit row (counts only, never e-mails).
import { Hono } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { ADMIN_AUTO_REASONS, adminWaitlistListQuerySchema, ok, parseWith, type AdminWaitlistPage, type AdminWaitlistRow, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { registerExport, send, withAdmin, type AdminEnv } from '../core';
import { dtReq, likeOf } from '../users/util';

type Q = { q?: string | undefined; segment?: string | undefined; page: number; pageSize: number };

async function listWaitlist(q: Q, tx?: Tx, all?: number): Promise<AdminWaitlistPage> {
  const db = tx ?? (await dbm()).db;
  const w: SQL[] = [];
  if (q.q) w.push(sql`email ilike ${likeOf(q.q)}`);
  if (q.segment) w.push(sql`segment = ${q.segment}`);
  const where = w.length ? sql`where ${sql.join(w, sql` and `)}` : sql``;
  const limit = all ?? q.pageSize;
  const offset = all ? 0 : (q.page - 1) * q.pageSize;
  const [rows, [t]] = await Promise.all([
    db.execute(sql`select id, email, segment, variant, source, created_at from waitlist ${where} order by created_at desc, id limit ${limit} offset ${offset}`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from waitlist ${where}`),
  ]);
  const items = [...rows].map((r): AdminWaitlistRow => ({
    id: r.id as string, email: r.email as string, segment: (r.segment as string | null) ?? null, variant: (r.variant as string | null) ?? null,
    origin: (r.source as string | null) ?? null, createdAt: dtReq(r.created_at),
  }));
  return { items, total: t?.n ?? 0, page: q.page, pageSize: q.pageSize };
}

// ponytail: one CSV in memory, capped; stream it if exports ever need more rows.
const EXPORT_MAX_ROWS = 10_000;
registerExport('waitlist', async (filters, tx) => {
  const q = parseWith(adminWaitlistListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const { items } = await listWaitlist({ ...q.data, page: 1, pageSize: EXPORT_MAX_ROWS }, tx, EXPORT_MAX_ROWS);
  return ok({ header: ['id', 'email', 'momento', 'variante', 'origem', 'criado_em'], rows: items.map((r) => [r.id, r.email, r.segment, r.variant, r.origin, r.createdAt]) });
});

export const waitlistRoutes = new Hono<AdminEnv>().get('/', async (c) => {
  const q = parseWith(adminWaitlistListQuerySchema, c.req.query());
  if (!q.ok) return send(q);
  const r: Result<AdminWaitlistPage & { audit: unknown }> = await withAdmin(
    c, 'waitlist.view', { reason: ADMIN_AUTO_REASONS.waitlistView, target: { type: 'route', id: '/v1/admin/waitlist' }, sensitive: false },
    async (tx, audit) => {
      const page = await listWaitlist(q.data, tx);
      audit.after({ total: page.total, returned: page.items.length, page: page.page, q: Boolean(q.data.q), segment: q.data.segment ?? null });
      return ok(page);
    },
  );
  if (!r.ok) return send(r);
  const { audit: _audit, ...page } = r.data;
  void _audit;
  return send(ok(page));
});
