import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { identityProviders, type LinkedIdentity } from '@remoa/contracts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: only server code, never a user token. */
export const adminClient = (): SupabaseClient => createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE'), opts);
/** Throwaway anon client: one per reauthentication so sessions never leak between requests. */
export const anonClient = (): SupabaseClient => createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), opts);

export type AuthInfo = { email: string; emailConfirmed: boolean; pendingEmail: string | null; identities: LinkedIdentity[]; joinedAt: Date };

const providers = new Set<string>(identityProviders);
export const authInfoOf = (u: User): AuthInfo => ({
  email: u.email ?? '',
  emailConfirmed: !!u.email_confirmed_at,
  pendingEmail: u.new_email ?? null,
  joinedAt: new Date(u.created_at),
  identities: (u.identities ?? [])
    .filter((i) => providers.has(i.provider))
    .map((i) => ({
      provider: i.provider as LinkedIdentity['provider'],
      email: typeof i.identity_data?.email === 'string' ? i.identity_data.email : null,
      createdAt: new Date(i.created_at ?? u.created_at),
      lastSignInAt: i.last_sign_in_at ? new Date(i.last_sign_in_at) : null,
    })),
});

export async function loadAuthUser(userId: string): Promise<User | null> {
  const { data, error } = await adminClient().auth.admin.getUserById(userId);
  return error ? null : data.user;
}
