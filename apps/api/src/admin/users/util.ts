// F19 T5 shared helpers for the users, maps and referrals lanes (admin lists run raw SQL on the server connection, never as the viewed user).
import { and, desc, eq, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { idSchema, type AuditEntry, type AuditTargetType } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { toEntry } from '../core';

export const isUuid = (v: string) => idSchema.safeParse(v).success;
/** Raw `execute` hands timestamptz back as string or Date. */
export const dt = (v: unknown) => (v == null ? null : new Date(v as string | Date));
export const dtReq = (v: unknown) => new Date(v as string | Date);
export const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Drawer "linha do tempo"/trilha: audit rows (success and denied) for these targets, newest first. */
export async function trailOf(targets: [AuditTargetType, string][], tx?: Tx, limit = 50): Promise<AuditEntry[]> {
  const { db, adminAuditLog: a, profiles, authUsers } = await dbm();
  const p = alias(profiles, 'actor_profile');
  const u = alias(authUsers, 'actor_user');
  const where: SQL = or(...targets.map(([t, id]) => and(eq(a.targetType, t), eq(a.targetId, id))))!;
  const rows = await (tx ?? db).select({ a, name: p.name, email: u.email }).from(a)
    .leftJoin(p, eq(p.userId, a.actorId)).leftJoin(u, eq(u.id, a.actorId))
    .where(where).orderBy(desc(a.createdAt), desc(a.id)).limit(limit);
  return rows.map((r) => toEntry(r.a, r.a.actorId ? { id: r.a.actorId, name: r.name, email: r.email } : null));
}
