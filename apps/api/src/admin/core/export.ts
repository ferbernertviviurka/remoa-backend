// F19 POST /v1/admin/export (FR-13, FR-16, FR-19, FR-21). Each resource lane registers its own rows; the core audits
// (`export.csv`, withAdmin) and, for users/payments, e-mails an alert to every admin.
import { eq } from 'drizzle-orm';
import type { Result } from '@remoa/contracts';
import { adminExportResources } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import type { Logger } from '@remoa/log';
import { dbm } from '../../db';
import { randomUUID } from 'node:crypto';
import { env } from '@remoa/config';
import { notify } from '../../notifications/notify';

export type ExportResource = (typeof adminExportResources)[number];
export type Cell = string | number | boolean | Date | null | undefined;
/** `filters` = the raw query of that resource's list route: validate with its list schema (invalid = `validation`). */
export type ExportFn = (filters: Record<string, string>, tx: Tx) => Promise<Result<{ header: string[]; rows: Cell[][] }>>;

const registry = new Map<ExportResource, ExportFn>();
/** Called at module load by the lane that owns the resource (T4: overview, payments; T5: users; core: audit). */
export const registerExport = (resource: ExportResource, fn: ExportFn) => void registry.set(resource, fn);
export const getExport = (resource: ExportResource) => registry.get(resource);

const cell = (v: Cell) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV formula injection (Excel/Sheets)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** RFC 4180, CRLF, BOM so Excel pt-BR opens UTF-8 correctly. */
export const toCsv = (header: string[], rows: Cell[][]) => `\ufeff${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

/** FR-21: alert every admin when users or payments are exported. Never fails the export (logged). */
export async function sendExportAlert(resource: ExportResource, rows: number, log: Logger, at = new Date()) {
  if (resource !== 'users' && resource !== 'payments') return;
  try {
    const { db, profiles } = await dbm();
    const admins = await db.select({ id: profiles.userId, name: profiles.name }).from(profiles).where(eq(profiles.role, 'admin'));
    const version = resource === 'users' ? 'export_users' : 'export_payments';
    const auditUrl = `${env().appUrl}/admin/auditoria`;
    const ref = randomUUID(); // one per export, so two exports in a row both alert
    await Promise.all(admins.map((a) => notify(a.id, 'admin_alert', {
      reference: `${ref}:${a.id}`,
      email: { version, name: a.name?.trim().split(/\s+/)[0] || null, count: rows, at: at.toISOString(), timezone: 'America/Sao_Paulo', auditUrl },
    })));
  } catch (e) {
    log.error('export alert failed', { resource, error: e instanceof Error ? e.message : String(e) });
  }
}
