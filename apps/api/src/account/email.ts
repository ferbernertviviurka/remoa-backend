import { sql } from 'drizzle-orm';
import {
  ACCOUNT_LIMITS, err, ok, type CancelEmailChange, type RequestEmailChange, type ResendEmailChange,
} from '@remoa/contracts';
import { dbm } from '../db';
import { isAccountDeleted } from './account';
import { anonClient, authInfoOf, loadAuthUser } from './auth-admin';
import { recordEvent, releaseSlot, takeSlot } from './events';

const GENERIC = 'email_change_failed'; // never reveals whether the address belongs to another account

/**
 * FR-7. Reauthenticates with the current password on a throwaway client, then `updateUser({ email })` on that same session:
 * GoTrue (double_confirm_changes) mails the link to the new address and the notice/confirmation to the old one (admin.generateLink sends nothing).
 */
export const requestEmailChange: RequestEmailChange = async (userId, { newEmail, currentPassword }) => {
  if (await isAccountDeleted(userId)) return err('forbidden', 'account_deleted'); // D-123
  const user = await loadAuthUser(userId);
  if (!user?.email) return err('not_found', 'user not found');
  if (newEmail === user.email.toLowerCase()) return err('validation', GENERIC);
  // Google-only (no password): OAuth reauth is behind NEXT_PUBLIC_AUTH_GOOGLE (D-013), so refuse until it exists.
  if (!currentPassword) return err('validation', 'password_required');
  const { db } = await dbm();
  // Counted as a failure up front (parallel guesses cannot all pass) and released on success; shares the POST /password budget.
  const slot = await takeSlot(userId, 'password_change_failed', ACCOUNT_LIMITS.passwordAttemptsPerHour, 3_600_000, { via: 'email_change' });
  if (!slot) return err('rate_limited', 'too many attempts');
  const client = anonClient();
  const { error: authError } = await client.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (authError) return err('validation', 'wrong_password');
  await releaseSlot(slot);
  try {
    const { error } = await client.auth.updateUser({ email: newEmail });
    if (error) return error.status === 429 ? err('rate_limited', 'try again later') : err('validation', GENERIC);
  } finally {
    await client.auth.signOut({ scope: 'local' }); // only the session created here; the default 'global' would end every session of the user
  }
  await recordEvent(db, userId, 'email_change_requested');
  return ok({ pendingEmail: newEmail });
};

export const resendEmailChange: ResendEmailChange = async (userId) => {
  if (await isAccountDeleted(userId)) return err('forbidden', 'account_deleted');
  const pending = authInfoOf((await loadAuthUser(userId)) ?? ({} as never)).pendingEmail;
  if (!pending) return err('conflict', 'no pending email change');
  const slot = await takeSlot(userId, 'email_change_resent', 1, ACCOUNT_LIMITS.emailResendSeconds * 1000);
  if (!slot) return err('rate_limited', 'wait before resending');
  const { error } = await anonClient().auth.resend({ type: 'email_change', email: pending });
  if (error) {
    await releaseSlot(slot); // a failed send must not burn the minute
    return error.status === 429 ? err('rate_limited', 'try again later') : err('internal', 'resend failed');
  }
  return ok({ pendingEmail: pending });
};

/** Clears GoTrue's pending change (no admin endpoint for it, so SQL on auth.users). Not blocked by scheduled deletion: it only undoes. */
export const cancelEmailChange: CancelEmailChange = async (userId) => {
  const { db } = await dbm();
  await db.execute(sql`update auth.users set email_change = '', email_change_token_new = '', email_change_token_current = '', email_change_sent_at = null, email_change_confirm_status = 0 where id = ${userId}`);
  await recordEvent(db, userId, 'email_change_canceled');
  return ok(null);
};
