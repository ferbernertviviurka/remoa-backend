// F19 FR-19: admin_audit_log is append-only (DB trigger, D-429). This module only inserts and reads; nothing here updates or deletes.
import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import type { AdminUserRef, AuditEntry, AuditListQuery, AuditPage } from '@remoa/contracts';
import { auditListQuerySchema } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { clientIp } from '../../client-ip';

type Row = typeof import('@remoa/db').adminAuditLog.$inferInsert;
type Meta = Pick<Row, 'ipHash' | 'userAgent' | 'requestId'>;

/** sha256(ip + AUDIT_IP_SALT), never the IP (D-429). No salt = no hash (a bare sha256 of an IPv4 is reversible). */
export function ipHash(ip: string | undefined, salt = process.env.AUDIT_IP_SALT) {
  return ip && salt ? createHash('sha256').update(ip + salt).digest('hex') : null;
}

/** The IP comes from clientIp (D-537): forwarded headers only through a trusted hop. */
export function auditMeta(c: Pick<Context, 'req' | 'get' | 'env'>): Meta {
  const ip = clientIp(c);
  return { ipHash: ipHash(ip === 'unknown' ? undefined : ip), userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null, requestId: (c.get('requestId') as string | undefined) ?? null };
}

export function toEntry(r: typeof import('@remoa/db').adminAuditLog.$inferSelect, actor: AdminUserRef | null, targetLabel: string | null = null): AuditEntry {
  return {
    id: r.id, createdAt: r.createdAt, actorType: r.actorType, actor, action: r.action as AuditEntry['action'],
    targetType: r.targetType as AuditEntry['targetType'], targetId: r.targetId, targetLabel, reason: r.reason, result: r.result,
    denial: r.denial as AuditEntry['denial'], before: r.before ?? null, after: r.after ?? null, ipHash: r.ipHash, userAgent: r.userAgent, requestId: r.requestId,
  };
}

/** Insert one row (in `tx` when given) and return it as the panel shows it. */
export async function writeAudit(values: Row, tx?: Tx, actor: AdminUserRef | null = null): Promise<AuditEntry> {
  const { db, adminAuditLog } = await dbm();
  const [row] = await (tx ?? db).insert(adminAuditLog).values(values).returning();
  return toEntry(row!, actor);
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

/** FR-19 list: filters + search on the server, newest first. `q` matches reason, target, actor name/e-mail, or "a_1050". */
export async function queryAudit(q: AuditListQuery, opts: { limit: number; offset: number }, tx?: Tx) {
  const { db, adminAuditLog: a, profiles, authUsers } = await dbm();
  const f = auditListQuerySchema.parse(q);
  const u = alias(authUsers, 'actor_user');
  const p = alias(profiles, 'actor_profile');
  const search: SQL[] = [];
  if (f.from) search.push(gte(a.createdAt, f.from));
  if (f.to) search.push(lte(a.createdAt, f.to));
  if (f.q) {
    const id = /^a_?(\d{1,15})$/i.exec(f.q)?.[1];
    const like = `%${escapeLike(f.q)}%`;
    search.push(id ? eq(a.id, Number(id)) : or(ilike(a.reason, like), ilike(a.targetId, like), ilike(p.name, like), ilike(u.email, like))!);
  }
  const where: SQL[] = [...search];
  if (f.actorId) where.push(eq(a.actorId, f.actorId));
  if (f.actorType) where.push(eq(a.actorType, f.actorType));
  if (f.result) where.push(eq(a.result, f.result));
  if (f.action) where.push(eq(a.action, f.action));
  const cond = where.length ? and(...where) : undefined;
  const conn = tx ?? db;
  // Labels by target_type in the same query (correlated subselects, no N+1).
  const label = sql<string | null>`case ${a.targetType}
    when 'user' then (select tp.name from profiles tp where tp.user_id::text = ${a.targetId})
    when 'board' then (select tb.title from boards tb where tb.id::text = ${a.targetId})
    when 'ticket' then (select '#' || tt.number from support_tickets tt where tt.id::text = ${a.targetId})
    when 'payment' then ${a.targetId} when 'referral' then ${a.targetId} when 'grant' then ${a.targetId} end`;
  const summaryCond = search.length ? and(...search) : undefined;
  const [rows, [t], [s]] = await Promise.all([
    conn.select({ a, name: p.name, email: u.email, label }).from(a).leftJoin(p, eq(p.userId, a.actorId)).leftJoin(u, eq(u.id, a.actorId)).where(cond)
      .orderBy(desc(a.createdAt), desc(a.id)).limit(opts.limit).offset(opts.offset),
    conn.select({ n: count() }).from(a).leftJoin(p, eq(p.userId, a.actorId)).leftJoin(u, eq(u.id, a.actorId)).where(cond),
    conn.select({
      total: count(),
      admin: sql<number>`count(*) filter (where ${a.actorType} = 'admin')`,
      system: sql<number>`count(*) filter (where ${a.actorType} in ('system','stripe'))`,
      denied: sql<number>`count(*) filter (where ${a.result} = 'denied')`,
    }).from(a).leftJoin(p, eq(p.userId, a.actorId)).leftJoin(u, eq(u.id, a.actorId)).where(summaryCond),
  ]);
  return {
    items: rows.map((r) => toEntry(r.a, r.a.actorId ? { id: r.a.actorId, name: r.name, email: r.email } : null, r.label ?? null)),
    total: Number(t?.n ?? 0),
    summary: { total: Number(s?.total ?? 0), admin: Number(s?.admin ?? 0), system: Number(s?.system ?? 0), denied: Number(s?.denied ?? 0) },
  };
}

export async function listAudit(q: AuditListQuery): Promise<AuditPage> {
  const f = auditListQuerySchema.parse(q);
  const { items, total, summary } = await queryAudit(f, { limit: f.pageSize, offset: (f.page - 1) * f.pageSize });
  return { items, total, summary, page: f.page, pageSize: f.pageSize };
}
