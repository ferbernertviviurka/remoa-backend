// F13 FR-11: devices = auth.sessions read and deleted by the server connection (D-124). Every query filters by the token's user_id.
import { sql } from 'drizzle-orm';
import { err, ok, type ListSessions, type RevokeOtherSessions, type RevokeSession } from '@remoa/contracts';
import { dbm } from '../db';
import { parseUserAgent, recordEvent, type EventMeta } from './events';

type Row = { id: string; user_agent: string | null; created_at: Date | string; last_active_at: Date | string };

/** refreshed_at is `timestamp without time zone` in UTC; the ip column is never selected. */
export const listSessions = async (userId: string, sessionId: string): ReturnType<ListSessions> => {
  const { db } = await dbm();
  const rows = await db.execute<Row>(sql`
    select id, user_agent,
      coalesce(created_at, now()) as created_at,
      coalesce(refreshed_at at time zone 'UTC', updated_at, created_at, now()) as last_active_at
    from auth.sessions
    where user_id = ${userId} and (not_after is null or not_after > now())
    order by last_active_at desc`);
  return ok(
    [...rows].map((r) => ({
      id: r.id,
      ...parseUserAgent(r.user_agent),
      createdAt: new Date(r.created_at),
      lastActiveAt: new Date(r.last_active_at),
      current: r.id === sessionId,
    })),
  );
};

/** Deletes sessions of `userId`; refresh tokens cascade, and getUser() rejects the old access token at once (D-124). */
export async function deleteSessions(userId: string, opts: { only: string } | { except: string }) {
  const { db } = await dbm();
  const where = 'only' in opts ? sql`id = ${opts.only}` : sql`id <> ${opts.except}`;
  const rows = await db.execute<{ id: string }>(sql`delete from auth.sessions where user_id = ${userId} and ${where} returning id`);
  return rows.length;
}

export async function countSessions(userId: string, except: string) {
  const { db } = await dbm();
  const [r] = await db.execute<{ n: number }>(sql`select count(*)::int as n from auth.sessions where user_id = ${userId} and id <> ${except}`);
  return r?.n ?? 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const revokeSession = async (userId: string, sessionId: string, targetId: string, meta?: EventMeta): ReturnType<RevokeSession> => {
  if (targetId === sessionId) return err('validation', 'current session: use sign out');
  // Another user's session and a malformed id look the same: not_found.
  if (!UUID.test(targetId) || !(await deleteSessions(userId, { only: targetId }))) return err('not_found', 'session not found');
  const { db } = await dbm();
  await recordEvent(db, userId, 'session_revoked', { ...meta, count: 1 });
  return ok(null);
};

export const revokeOtherSessions = async (userId: string, sessionId: string, meta?: EventMeta): ReturnType<RevokeOtherSessions> => {
  const count = await deleteSessions(userId, { except: sessionId });
  if (count) await recordEvent((await dbm()).db, userId, 'session_revoked', { ...meta, count });
  return ok({ count });
};
