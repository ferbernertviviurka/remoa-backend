/** D-1805/CCR144: metadata-only outbox pages (owner via RLS transaction, admin via withAdmin). Never selects payload_reference. */
import { sql, type SQL } from 'drizzle-orm';
import { err, ok, questionOutboxItemSchema, questionAdminOutboxItemSchema } from '@remoa/contracts';
import { decodeCatalogCursor, encodeCatalogCursor, type CatalogCursorScope } from '../editorial/catalog';

type Row = Record<string, unknown>;
type State = 'pending' | 'leased' | 'exhausted' | 'delivered';
type Query = { state?: State; target?: 'question-receipt' | 'question-promotion'; ownerId?: string; limit: number; cursor?: string };

const iso = (col: SQL) => sql`to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Same predicates the worker (reconcile.ts) and the recovery use: lease first, then budget. */
export const outboxState = sql`CASE WHEN o.delivered_at IS NOT NULL THEN 'delivered' WHEN o.lease_until > now() THEN 'leased' WHEN o.attempts >= o.attempt_limit THEN 'exhausted' ELSE 'pending' END`;
const stateFilter: Record<State, SQL> = {
  delivered: sql`o.delivered_at IS NOT NULL`,
  leased: sql`o.delivered_at IS NULL AND o.lease_until > now()`,
  exhausted: sql`o.delivered_at IS NULL AND (o.lease_until IS NULL OR o.lease_until <= now()) AND o.attempts >= o.attempt_limit`,
  pending: sql`o.delivered_at IS NULL AND (o.lease_until IS NULL OR o.lease_until <= now()) AND o.attempts < o.attempt_limit`,
};
/** Stored codes are worker-written; anything outside the wire grammar (e.g. an exception class name) is reported generically. */
const code = (v: unknown) => (typeof v !== 'string' ? null : /^[a-z_]{3,100}$/.test(v) ? v : 'unclassified_error');

export function outboxPageSQL(q: Query, cur: { at: string; id: string } | null, ownerId?: string) {
  const where: SQL[] = [sql`o.target IN ('question-receipt','question-promotion')`];
  const owner = ownerId ?? q.ownerId;
  if (owner) where.push(sql`r.user_id = ${owner}::uuid`);
  if (q.state) where.push(stateFilter[q.state]);
  if (q.target) where.push(sql`o.target = ${q.target}`);
  if (cur) where.push(sql`(o.created_at, o.id) < (${cur.at}::timestamptz, ${cur.id}::uuid)`);
  return sql`SELECT o.id "outboxId", o.run_id "runId", r.producer, o.target, ${outboxState} state, o.attempts, o.attempt_limit "attemptLimit", o.error_code "errorCode",
    ${iso(sql`o.created_at`)} "createdAt", ${iso(sql`o.updated_at`)} "updatedAt", ${iso(sql`o.delivered_at`)} "deliveredAt", r.user_id "ownerId"
    FROM question_outbox o JOIN question_generation_runs r ON r.id = o.run_id
    WHERE ${sql.join(where, sql` AND `)} ORDER BY o.created_at DESC, o.id DESC LIMIT ${q.limit + 1}`;
}

/** `exec` runs the statement (owner: asServer inside run(); admin: the withAdmin tx). `ownerId` pins the owner list to its caller. */
export async function outboxPage(exec: (q: SQL) => Promise<Row[]>, q: Query, scope: CatalogCursorScope, ownerId?: string) {
  const cur = q.cursor ? decodeCatalogCursor(q.cursor, scope) : null;
  if (q.cursor && !cur) return err('validation', 'invalid_cursor');
  const rows = await exec(outboxPageSQL(q, cur, ownerId));
  const selected = rows.slice(0, q.limit), last = selected.at(-1);
  const items = selected.map((r) => {
    const base = { outboxId: r.outboxId, runId: r.runId, producer: r.producer, target: r.target, state: r.state, attempts: r.attempts, attemptLimit: r.attemptLimit, errorCode: code(r.errorCode), createdAt: r.createdAt, updatedAt: r.updatedAt, deliveredAt: r.deliveredAt };
    return ownerId ? questionOutboxItemSchema.parse(base) : questionAdminOutboxItemSchema.parse({ ...base, ownerId: r.ownerId });
  });
  return ok({ items, nextCursor: rows.length > q.limit && last ? encodeCatalogCursor(String(last.createdAt), String(last.outboxId), scope) : null });
}
