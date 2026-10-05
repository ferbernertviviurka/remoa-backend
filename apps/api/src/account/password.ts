// F13 FR-9: change password with reauthentication, 5 failures/hour, other sessions revoked, notice by e-mail.
import { eq } from 'drizzle-orm';
import { ACCOUNT_LIMITS, changePasswordInputSchema, err, ok, parseWith, type ChangePassword } from '@remoa/contracts';
import { randomUUID } from 'node:crypto';
import { env } from '@remoa/config';
import { dbm } from '../db';
import { notify } from '../notifications/notify';
import { anonClient, loadAuthUser } from './auth-admin';
import { recordEvent, releaseSlot, takeSlot, type EventMeta } from './events';
import { countSessions, deleteSessions } from './sessions';

const HOUR = 3_600_000;
const sessionIdOf = (jwt: string) => {
  try {
    const claim = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()).session_id;
    return typeof claim === 'string' ? claim : null;
  } catch {
    return null;
  }
};

/**
 * True when `password` is the user's current one. Signs in on a throwaway anon client and deletes exactly the session
 * that sign-in created (by id, filtered by user_id). Not signOut(): its default scope is 'global' and ends every session.
 */
export async function verifyPassword(userId: string, email: string, password: string) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error || data.user?.id !== userId) return false;
  const sid = data.session ? sessionIdOf(data.session.access_token) : null;
  if (sid) await deleteSessions(userId, { only: sid });
  return true;
}

/**
 * PUT /auth/v1/user with the caller's own token. GoTrue then revokes every session except the token's (UpdatePassword(tx, &sessionID)).
 * Not auth.admin.updateUserById: the admin path passes no session and ends ALL sessions, the current one included (verified locally).
 * Needs `secure_password_change = false` in GoTrue (sessions older than 24 h would need a nonce); our reauth replaces it.
 */
async function updateOwnPassword(accessToken: string, password: string) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error_code?: string };
  return body.error_code ?? `http_${res.status}`;
}

export const changePassword = async (
  userId: string,
  sessionId: string,
  input: unknown,
  { accessToken, meta = {} }: { accessToken: string; meta?: EventMeta },
): ReturnType<ChangePassword> => {
  const parsed = parseWith(changePasswordInputSchema, input);
  if (!parsed.ok) return err('validation', parsed.error.message.includes('weak password') ? 'weak_password' : parsed.error.message);
  const { currentPassword, newPassword } = parsed.data;

  // The attempt is counted as a failure up front (so parallel guesses cannot all pass the check) and released on success.
  const slot = await takeSlot(userId, 'password_change_failed', ACCOUNT_LIMITS.passwordAttemptsPerHour, HOUR, meta);
  if (!slot) return err('rate_limited', 'too many password attempts');

  const user = await loadAuthUser(userId);
  if (!user?.email || !(await verifyPassword(userId, user.email, currentPassword))) return err('validation', 'wrong_password');
  await releaseSlot(slot);

  // Count before: GoTrue's update ends the other sessions itself; the delete after is a belt for any it missed.
  const before = await countSessions(userId, sessionId);
  const failure = await updateOwnPassword(accessToken, newPassword);
  if (failure === 'same_password') return err('validation', 'same_password');
  if (failure) return err('internal', 'password update failed');
  const revokedSessions = Math.max(before, await deleteSessions(userId, { except: sessionId }));

  const { db, profiles } = await dbm();
  await recordEvent(db, userId, 'password_changed', { ...meta, revokedSessions });
  const [p] = await db.select({ name: profiles.name, tz: profiles.timezone }).from(profiles).where(eq(profiles.userId, userId));
  // The password is already changed: notify() never throws, and a mail outage is logged there.
  await notify(userId, 'password_changed', {
    reference: randomUUID(),
    email: { name: p?.name?.split(' ')[0] || null, changedAt: new Date().toISOString(), timezone: p?.tz ?? 'America/Sao_Paulo', resetUrl: `${env().appUrl}/entrar` },
  });
  return ok({ revokedSessions });
};
