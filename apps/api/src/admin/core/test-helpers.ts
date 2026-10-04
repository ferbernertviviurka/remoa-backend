// Test-only: fake Supabase-shaped access tokens (payload carries sub + amr) and a verifier that trusts known users.
import type { VerifyToken } from '../../app';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** `signedInAgoMs` = time since the last real sign-in (amr timestamp); null = no amr claim. */
export const fakeToken = (sub: string, signedInAgoMs: number | null = 60_000) =>
  `h.${b64({ sub, ...(signedInAgoMs === null ? {} : { amr: [{ method: 'password', timestamp: Math.floor((Date.now() - signedInAgoMs) / 1000) }] }) })}.s`;

export const fakeVerifier = (known: string[]): VerifyToken => async (t) => {
  try {
    const sub = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString()).sub;
    return known.includes(sub) ? sub : null;
  } catch {
    return null;
  }
};
