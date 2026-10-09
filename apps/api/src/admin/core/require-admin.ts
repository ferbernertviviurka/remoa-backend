// F19 FR-11, D-431: every /v1/admin/* request. Non-admin (or no session) = the same 404 as an unknown route + a throttled
// `admin.access` denied row. Role, suspension and deletion are read from the database on every request (never the JWT).
import { createMiddleware } from 'hono/factory';
import { eq, sql } from 'drizzle-orm';
import { ADMIN_LIMITS, adminErrors, errorHttpStatus, type AdminUserRef, type AppError, type HttpErrorBody } from '@remoa/contracts';
import type { Env, VerifyToken } from '../../app';
import { dbm } from '../../db';
import { auditMeta, writeAudit } from './audit';

export type AdminEnv = { Variables: Env['Variables'] & { admin: AdminUserRef & { email: string }; authAt: number | null } };

// Local copy of app.ts `fail` (importing app.ts here would be a module cycle).
export const fail = (error: AppError) => Response.json({ error } satisfies HttpErrorBody, { status: errorHttpStatus[error.code] });

/** Same body as app.notFound: a non-admin cannot tell an admin route from a missing one. */
export const notFound = () => fail({ code: 'not_found', message: 'route not found' });

/** One statement, primary-key lookups only (profiles + auth.users). Server connection: the caller is the user themself. */
export async function accountState(userId: string) {
  const { db, profiles, authUsers } = await dbm();
  const [p] = await db
    .select({ role: profiles.role, deletedAt: profiles.deletedAt, suspendedAt: profiles.suspendedAt, name: profiles.name, email: authUsers.email })
    .from(profiles)
    .leftJoin(authUsers, eq(authUsers.id, profiles.userId))
    .where(eq(profiles.userId, userId));
  return p ?? null;
}

/**
 * Last real sign-in (ms): max `amr[].timestamp` of the access token (D-431; kept across refreshes, renewed by a new login).
 * Only read after verifyToken accepted the token, so the claims are trusted (same as session_id in supabaseVerifier).
 */
export function authenticatedAt(token: string | undefined): number | null {
  try {
    const amr: unknown = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString()).amr;
    const ts = Array.isArray(amr) ? amr.map((a) => Number(a?.timestamp)).filter((t) => Number.isFinite(t) && t > 0) : [];
    return ts.length ? Math.max(...ts) * 1000 : null;
  } catch {
    return null;
  }
}

export const isFresh = (authAt: number | null, maxMs: number, now = Date.now()) => authAt !== null && now - authAt <= maxMs;

/** Prefer the token's amr clock. Tokens without it use the session row's sign-in time, so a new login can leave the confirm screen. */
export const resolveAuthAt = (fromToken: number | null, sessionCreatedAt: number | null) => fromToken ?? sessionCreatedAt;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sessionCreatedAt(sessionId: string, userId: string): Promise<number | null> {
  if (!UUID.test(sessionId) || !UUID.test(userId)) return null;
  const { db } = await dbm();
  const [row] = await db.execute<{ created_at: Date | string }>(sql`
    select created_at from auth.sessions where id = ${sessionId}::uuid and user_id = ${userId}::uuid`);
  if (!row) return null;
  const at = new Date(row.created_at).getTime();
  return Number.isFinite(at) && at > 0 ? at : null;
}

const THROTTLE_MS = 10 * 60_000;
const PER_CALLER = 20;
const lastDenied = new Map<string, number>();
const callerHits = new Map<string, number[]>();
/**
 * D-431/D-445: at most one denied row per caller + route every 10 min, and at most 20 per caller in that window (random paths
 * would otherwise flood an append-only table). ponytail: in-memory, one API instance (Q-008); move to the DB if it scales out.
 */
export function takeDeniedSlot(caller: string, route: string, now = Date.now()) {
  if (lastDenied.size > 10_000) for (const [k, t] of lastDenied) if (now - t >= THROTTLE_MS) lastDenied.delete(k);
  if (callerHits.size > 10_000) for (const [k, v] of callerHits) if (v.every((t) => now - t >= THROTTLE_MS)) callerHits.delete(k);
  const key = `${caller}|${route}`;
  const t = lastDenied.get(key);
  const hits = (callerHits.get(caller) ?? []).filter((h) => now - h < THROTTLE_MS);
  if ((t !== undefined && now - t < THROTTLE_MS) || hits.length >= PER_CALLER) return false;
  lastDenied.set(key, now);
  callerHits.set(caller, [...hits, now]);
  return true;
}

export const requireAdmin = (verifyToken: VerifyToken) =>
  createMiddleware<AdminEnv>(async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    const v = token ? await verifyToken(token).catch(() => null) : null;
    const { userId, sessionId } = typeof v === 'string' ? { userId: v, sessionId: null } : (v ?? { userId: null, sessionId: null });
    const s = userId ? await accountState(userId) : null;
    if (!userId || !s || s.role !== 'admin' || s.deletedAt || s.suspendedAt || !s.email) {
      const route = `${c.req.method} ${c.req.path}`.slice(0, 300);
      const meta = auditMeta(c);
      if (takeDeniedSlot(userId ?? meta.ipHash ?? 'anon', route))
        await writeAudit({ ...meta, actorType: 'user', actorId: userId, action: 'admin.access', targetType: 'route', targetId: route, result: 'denied', denial: 'not_admin' })
          .catch((e) => c.get('log').error('admin.access audit failed', { error: e instanceof Error ? e.message : String(e) }));
      return notFound();
    }
    const fromToken = authenticatedAt(token);
    const authAt = resolveAuthAt(fromToken, fromToken === null && sessionId ? await sessionCreatedAt(sessionId, userId).catch(() => null) : null);
    c.set('userId', userId);
    c.set('sessionId', sessionId);
    c.set('admin', { id: userId, name: s.name, email: s.email });
    c.set('authAt', authAt);
    // FR-11: 12 h admin session since the last sign-in; GET /me stays open so the web can ask for a new login.
    if (!(c.req.method === 'GET' && c.req.path === '/v1/admin/me') && !isFresh(authAt, ADMIN_LIMITS.sessionHours * 3_600_000))
      return fail({ code: 'forbidden', message: adminErrors.reauth });
    await next();
  });
