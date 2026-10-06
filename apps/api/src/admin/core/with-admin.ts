// F19 FR-20, rule 9, D-432: the only door for admin actions. Exactly one audit row per call: `success` in the action's own
// transaction, or `denied` in a separate one that survives the rollback.
import type { Context } from 'hono';
import {
  ADMIN_LIMITS, adminErrors, err, errorHttpStatus, ok, reasonSchema,
  type AdminAction, type HttpErrorBody, type AuditDenial, type AuditEntry, type AuditTargetType, type Result,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { Abort, dbm } from '../../db';
import { auditMeta, writeAudit } from './audit';
import { isFresh, type AdminEnv } from './require-admin';
import { invalidate } from '../../cache';

export type AuditCapture = { before(v: unknown): void; after(v: unknown): void };
export type WithAdminOpts = { reason: string; target: { type: AuditTargetType; id: string }; sensitive?: boolean };

export async function withAdmin<T extends object>(
  c: Context<AdminEnv>,
  action: AdminAction,
  opts: WithAdminOpts,
  fn: (tx: Tx, audit: AuditCapture) => Promise<Result<T>>,
): Promise<Result<T & { audit: AuditEntry }>> {
  const admin = c.get('admin');
  const base = { ...auditMeta(c), actorType: 'admin' as const, actorId: admin.id, action, targetType: opts.target.type, targetId: opts.target.id };
  const raw = typeof opts.reason === 'string' ? opts.reason.trim().slice(0, ADMIN_LIMITS.reasonMax) : '';
  const deny = (denial: AuditDenial) =>
    writeAudit({ ...base, reason: raw || null, result: 'denied', denial }).catch((e) =>
      c.get('log').error('admin denied audit failed', { action, error: e instanceof Error ? e.message : String(e) }),
    );

  const reason = reasonSchema.safeParse(opts.reason);
  if (!reason.success) {
    await deny('missing_reason');
    return err('validation', `reason: at least ${ADMIN_LIMITS.reasonMin} characters`);
  }
  if (opts.sensitive !== false && !isFresh(c.get('authAt'), ADMIN_LIMITS.reauthMinutes * 60_000)) {
    await deny('reauth_required');
    return err('forbidden', adminErrors.reauth);
  }

  let before: unknown = null;
  let after: unknown = null;
  const capture: AuditCapture = { before: (v) => void (before = v), after: (v) => void (after = v) };
  try {
    const { db } = await dbm();
    const data = await db.transaction(async (tx) => {
      const r = await fn(tx, capture);
      if (!r.ok) throw new Abort(r.error); // rollback everything fn wrote
      const audit = await writeAudit({ ...base, reason: reason.data, result: 'success', before, after }, tx, admin);
      return { ...r.data, audit };
    });
    await invalidate('admin.action', { userId: opts.target.type === 'user' ? opts.target.id : undefined }); // after COMMIT: overview + the affected user's entries
    return ok(data);
  } catch (e) {
    if (e instanceof Abort) {
      await deny(e.error.code === 'conflict' ? 'invalid_state' : 'error');
      return { ok: false, error: e.error };
    }
    await deny('error');
    throw e;
  }
}

/** Action routes: pass the raw reason to withAdmin (it writes the `missing_reason` denied row); never pre-validate it. */
export const reasonOf = (body: unknown) => (body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string' ? (body as { reason: string }).reason : '');

/** Result → `{ ok, data }` or `{ error }` with its HTTP status. */
export const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
