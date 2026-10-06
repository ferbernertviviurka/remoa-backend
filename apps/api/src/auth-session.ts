// D-565: token check without the Auth round trip. Signature + exp are verified locally (getClaims: JWKS ES256, cached 10 min by
// auth-js; HS256 projects fall back to getUser), then ONE query proves the session still exists (D-124 revocation, sign-out),
// the user exists, is not banned and not deleted, and returns the profile flags requireUser used to read via accountState.
// G21 D-990: on GET/HEAD that query is not a round trip of its own: it rides in the first statement of the request's first run()
// (same statement as the RLS claims, see db.ts). requireUser checks it eagerly at the end if no run() did (and always on writes).
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminErrors, type AppError } from '@remoa/contracts';
import { dbm } from './db';

export type Account = { deletedAt: Date | null; suspendedAt: Date | null };
/**
 * `account` = the profile flags from the same query (null = no profile row); absent when the verifier did not read them (tests).
 * `pending` = only the signature was checked (D-990): the session query is still owed by this request.
 */
export type Verified = { userId: string; sessionId: string | null; account?: Account | null; pending?: true };

/** D-123: the only routes a soft-deleted account (7-day grace) can still call. */
export const DURING_DELETION = new Set(['GET /v1/account/me', 'POST /v1/account/deletion/cancel', 'POST /v1/account/export']);

/** F08 FR-7 soft delete (D-123 exceptions) and F19 suspension (D-430), by route. Null = may proceed. */
export function accountError(s: Account | null | undefined, route: string): AppError | null {
  if (s?.deletedAt && !DURING_DELETION.has(route)) return { code: 'forbidden', message: 'account_deleted' };
  if (s?.suspendedAt && route !== 'GET /v1/account/me') return { code: 'forbidden', message: adminErrors.suspended };
  return null;
}

/** Columns live (true when the session row matched), deleted_at, suspended_at, has_profile. Zero or one row. */
export const liveSessionSql = (userId: string, sessionId: string): SQL => sql`
    select true as live, p.deleted_at, p.suspended_at, p.user_id is not null as has_profile
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.user_id = s.user_id
    where s.id = ${sessionId} and s.user_id = ${userId}
      and (s.not_after is null or s.not_after > now())
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null`;

export type SessionRow = { live: boolean | null; deleted_at: Date | string | null; suspended_at: Date | string | null; has_profile: boolean | null };
const toAccount = (r: SessionRow): Account | null =>
  r.has_profile ? { deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at), suspendedAt: r.suspended_at === null ? null : new Date(r.suspended_at) } : null;

/** Null when the session is gone/expired or the user is missing, banned or deleted in auth.users. */
export async function liveSession(userId: string, sessionId: string): Promise<{ account: Account | null } | null> {
  const { db } = await dbm();
  const [r] = await db.execute<SessionRow>(liveSessionSql(userId, sessionId));
  return r ? { account: toAccount(r) } : null;
}

/** D-990: per-request memo of the session check. `state` goes pending → ok | the error the request must answer with. */
export type SessionGate = { userId: string; sessionId: string; route: string; state: 'pending' | 'ok' | AppError };
export const sessionGate = new AsyncLocalStorage<SessionGate>();

/** Thrown by run() when the fused check fails; app.onError and requireUser turn it into the 401/403. */
export class SessionRejected extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

const UNAUTHORIZED: AppError = { code: 'unauthorized', message: 'invalid or missing token' };

/** Records the outcome of the session columns (row missing / live null = dead session). Throws SessionRejected on failure. */
export function settleGate(g: SessionGate, r: SessionRow | undefined) {
  if (g.state !== 'pending') {
    if (g.state !== 'ok') throw new SessionRejected(g.state);
    return;
  }
  const e = !r?.live ? UNAUTHORIZED : accountError(toAccount(r), g.route);
  g.state = e ?? 'ok';
  if (e) throw new SessionRejected(e);
}

/** Eager check (no run() happened, or a write): the same query on its own. Returns the error to answer with, or null. */
export async function settleGateNow(g: SessionGate): Promise<AppError | null> {
  if (g.state === 'pending') {
    const { db } = await dbm();
    const [r] = await db.execute<SessionRow>(liveSessionSql(g.userId, g.sessionId));
    try {
      settleGate(g, r);
    } catch {
      /* state holds the error */
    }
  }
  return g.state === 'ok' ? null : (g.state as AppError);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Production verifier. A token without `session_id` (or a malformed one) is rejected: every GoTrue user token carries it.
 * `defer` (D-990, GET/HEAD only): skip the session query and return `pending`; requireUser makes the request pay it later.
 */
export const supabaseVerifier = (client: SupabaseClient) => async (token: string, opts?: { defer?: boolean }): Promise<Verified | null> => {
  const { data, error } = await client.auth.getClaims(token);
  const sub = data?.claims.sub;
  const sid = data?.claims.session_id;
  if (error || typeof sub !== 'string' || !UUID.test(sub) || typeof sid !== 'string' || !UUID.test(sid)) return null;
  if (opts?.defer) return { userId: sub, sessionId: sid, pending: true };
  const live = await liveSession(sub, sid);
  return live && { userId: sub, sessionId: sid, account: live.account };
};
