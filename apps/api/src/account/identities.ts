import { sql } from 'drizzle-orm';
import { err, ok, type UnlinkIdentity } from '@remoa/contracts';
import { dbm } from '../db';
import { authInfoOf, loadAuthUser } from './auth-admin';
import { recordEvent } from './events';
import { invalidate } from '../cache';

/** FR-10: never removes the last sign-in method. Linking Google is client-side OAuth. */
export const unlinkIdentity: UnlinkIdentity = async (userId, provider) => {
  // Removing the 'email' identity does not remove the password, so it would be a no-op for security: only Google can be unlinked.
  if (provider !== 'google') return err('validation', 'only_google_can_be_unlinked');
  const user = await loadAuthUser(userId);
  if (!user) return err('not_found', 'user not found');
  const have = authInfoOf(user).identities;
  if (!have.some((i) => i.provider === provider)) return err('not_found', 'identity not linked');
  if (have.length <= 1) return err('conflict', 'last_login_method');
  const { db } = await dbm();
  // ponytail: GoTrue's admin API has no identity delete (unlinkIdentity needs the user's session), so SQL on auth.*; revisit if GoTrue adds it.
  await db.execute(sql`delete from auth.identities where user_id = ${userId} and provider = ${provider}`);
  await db.execute(sql`update auth.users set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{providers}', coalesce((select jsonb_agg(i.provider) from auth.identities i where i.user_id = ${userId}), '[]'::jsonb)) where id = ${userId}`);
  await recordEvent(db, userId, 'identity_unlinked', { provider });
  await invalidate('profile.changed', { userId });
  return ok(have.filter((i) => i.provider !== provider));
};
