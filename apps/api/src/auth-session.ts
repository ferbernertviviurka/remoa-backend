// D-565: token check without the Auth round trip. Signature + exp are verified locally (getClaims: JWKS ES256, cached 10 min by
// auth-js; HS256 projects fall back to getUser), then ONE query proves the session still exists (D-124 revocation, sign-out),
// the user exists, is not banned and not deleted, and returns the profile flags requireUser used to read via accountState.
import { sql } from 'drizzle-orm';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dbm } from './db';

export type Account = { deletedAt: Date | null; suspendedAt: Date | null };
/** `account` = the profile flags from the same query (null = no profile row); absent when the verifier did not read them (tests). */
export type Verified = { userId: string; sessionId: string | null; account?: Account | null };

/** Null when the session is gone/expired or the user is missing, banned or deleted in auth.users. */
export async function liveSession(userId: string, sessionId: string): Promise<{ account: Account | null } | null> {
  const { db } = await dbm();
  const [r] = await db.execute<{ deleted_at: Date | null; suspended_at: Date | null; has_profile: boolean }>(sql`
    select p.deleted_at, p.suspended_at, p.user_id is not null as has_profile
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.user_id = s.user_id
    where s.id = ${sessionId} and s.user_id = ${userId}
      and (s.not_after is null or s.not_after > now())
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null`);
  if (!r) return null;
  return { account: r.has_profile ? { deletedAt: r.deleted_at && new Date(r.deleted_at), suspendedAt: r.suspended_at && new Date(r.suspended_at) } : null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Production verifier. A token without `session_id` (or a malformed one) is rejected: every GoTrue user token carries it. */
export const supabaseVerifier = (client: SupabaseClient) => async (token: string): Promise<Verified | null> => {
  const { data, error } = await client.auth.getClaims(token);
  const sub = data?.claims.sub;
  const sid = data?.claims.session_id;
  if (error || typeof sub !== 'string' || !UUID.test(sub) || typeof sid !== 'string' || !UUID.test(sid)) return null;
  const live = await liveSession(sub, sid);
  return live && { userId: sub, sessionId: sid, account: live.account };
};
