// F19 /v1/admin/* (D-431–D-434, rule 9). requireAdmin guards every path, unknown ones included (404 for non-admin and
// for unknown routes alike). Lanes add their routes in their own file (admin/<lane>/routes.ts); do not edit this one for that: each lane router is mounted at its prefix (`/users`, `/maps`, `/seeds`...), so it declares '/', '/:id', '/:id/suspend'.
import { Hono } from 'hono';
import { count, inArray } from 'drizzle-orm';
import { adminExportInputSchema, auditListQuerySchema, formatAuditId, parseWith, type AdminMe } from '@remoa/contracts';
import type { VerifyToken } from '../app';
import { dbm } from '../db';
import {
  adminRateLimit, getExport, listAudit, notFound, queryAudit, reasonOf, registerExport, requireAdmin, send, sendExportAlert, toCsv, withAdmin, type AdminEnv,
} from '../admin/core';
import { overviewRoutes } from '../admin/overview/routes';
import { usersRoutes } from '../admin/users/routes';
import { mapsRoutes, seedsRoutes } from '../admin/maps/routes';
import { paymentsRoutes } from '../admin/payments/routes';
import { referralsRoutes } from '../admin/referrals/routes';
import { waitlistRoutes } from '../admin/waitlist/routes';
import { storeWaitlistRoutes } from '../admin/store-waitlist/routes';
import { ticketsRoutes } from '../admin/tickets/routes';

// ponytail: one CSV in memory, capped; stream it if exports ever need more rows.
const EXPORT_MAX_ROWS = 10_000;

registerExport('audit', async (filters) => {
  const q = parseWith(auditListQuerySchema.omit({ page: true, pageSize: true }), filters);
  if (!q.ok) return q;
  const { items } = await queryAudit(q.data, { limit: EXPORT_MAX_ROWS, offset: 0 });
  return {
    ok: true,
    data: {
      header: ['id', 'quando', 'tipo_ator', 'ator', 'email_ator', 'acao', 'tipo_alvo', 'alvo', 'motivo', 'resultado', 'negacao', 'requisicao'],
      rows: items.map((e) => [formatAuditId(e.id), e.createdAt, e.actorType, e.actor?.name, e.actor?.email, e.action, e.targetType, e.targetId, e.reason, e.result, e.denial, e.requestId]),
    },
  };
});

export function adminRoutes({ verifyToken }: { verifyToken: VerifyToken }) {
  return new Hono<AdminEnv>()
    .use('*', requireAdmin(verifyToken))
    .use('*', adminRateLimit)
    .get('/me', async (c) => {
      const { db, supportTickets } = await dbm();
      const [t] = await db.select({ n: count() }).from(supportTickets).where(inArray(supportTickets.status, ['open', 'in_review']));
      const a = c.get('admin');
      return send({ ok: true, data: { ...a, authenticatedAt: new Date(c.get('authAt') ?? 0), openTickets: t?.n ?? 0 } satisfies AdminMe });
    })
    .get('/audit', async (c) => {
      const q = parseWith(auditListQuerySchema, c.req.query());
      return send(q.ok ? { ok: true, data: await listAudit(q.data) } : q);
    })
    .post('/export', async (c) => {
      const json: unknown = await c.req.json().catch(() => null);
      const body = parseWith(adminExportInputSchema.omit({ reason: true }), json);
      if (!body.ok) return send(body);
      const { resource, filters } = body.data;
      const fn = getExport(resource);
      if (!fn) return send({ ok: false, error: { code: 'not_found', message: `export ${resource} not available` } });
      const r = await withAdmin(c, 'export.csv', { reason: reasonOf(json), target: { type: 'export', id: resource } }, async (tx, audit) => {
        const rows = await fn(filters, tx);
        if (!rows.ok) return rows;
        audit.after({ resource, filters, rows: rows.data.rows.length });
        return { ok: true, data: { csv: toCsv(rows.data.header, rows.data.rows), rows: rows.data.rows.length } };
      });
      if (!r.ok) return send(r);
      await sendExportAlert(resource, r.data.rows, c.get('log'));
      return c.body(r.data.csv, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="remoa-${resource}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
        // The web shows "Ação registrada na auditoria (a_1050)" from these.
        'x-audit-id': String(r.data.audit.id),
        'access-control-expose-headers': 'x-audit-id, content-disposition',
      });
    })
    .route('/overview', overviewRoutes)
    .route('/users', usersRoutes)
    .route('/maps', mapsRoutes)
    .route('/seeds', seedsRoutes)
    .route('/payments', paymentsRoutes)
    .route('/referrals', referralsRoutes)
    .route('/tickets', ticketsRoutes)
    .route('/waitlist', waitlistRoutes)
    .route('/store-waitlist', storeWaitlistRoutes)
    .all('*', () => notFound());
}
