// F17 sharing secrets (D-289, D-290): link token, password hash, access grant and the limiter's HMACs.
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { SHARE_LIMITS, type SharedAccessGrant } from '@remoa/contracts';

type Access = 'owner' | 'password' | 'public';

const secret = () => {
  const s = process.env.SHARE_SECRET;
  if (!s) throw new Error('missing env SHARE_SECRET');
  return s;
};

/** 32 random bytes, base64url without padding (43 chars, matches shareTokenSchema). */
export const newShareToken = () => randomBytes(32).toString('base64url');

// Parameters are fixed per version: a hash keeps verifying after the current version's parameters change.
const SCRYPT: Record<string, { keylen: number; opts: ScryptOptions }> = {
  v1: { keylen: 32, opts: { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } },
};
const CURRENT = 'v1';

const derive = (pw: string, salt: Buffer, version: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const p = SCRYPT[version]!;
    scrypt(pw.normalize('NFC'), salt, p.keylen, p.opts, (e, key) => (e ? reject(e) : resolve(key)));
  });

/** `scrypt$v1$<salt>$<key>` (base64url). */
export async function hashSharePassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, CURRENT);
  return `scrypt$${CURRENT}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time compare; a malformed hash or unknown version is just `false`. */
export async function verifySharePassword(pw: string, hash: string): Promise<boolean> {
  const [algo, version = '', salt = '', key = ''] = hash.split('$');
  if (algo !== 'scrypt' || !SCRYPT[version] || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await derive(pw, Buffer.from(salt, 'base64url'), version);
  return got.length === want.length && timingSafeEqual(got, want);
}

const mac = (...parts: (string | number)[]) => createHmac('sha256', secret()).update(parts.join('|')).digest('base64url');

/**
 * `g1.<expEpochSeconds>.<mac>`, the MAC binding the link token, share_secret_version and expiry: rotating the link or
 * changing the password/access (both bump the version) invalidates every grant handed out before.
 */
export function signGrant(token: string, version: number, now = new Date()): SharedAccessGrant {
  const exp = Math.floor(now.getTime() / 1000) + SHARE_LIMITS.accessTtlSeconds;
  return { value: `g1.${exp}.${mac('grant', token, version, exp)}`, expiresAt: new Date(exp * 1000) };
}

export function verifyGrant(value: string | null | undefined, token: string, version: number, now = new Date()): boolean {
  if (!value) return false;
  const [tag, expRaw = '', sig = ''] = value.split('.');
  const exp = Number(expRaw);
  if (tag !== 'g1' || !/^\d{1,12}$/.test(expRaw) || exp * 1000 <= now.getTime()) return false;
  return sameMac(sig, mac('grant', token, version, exp));
}

const sameMac = (got: string, want: string) => {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Public image URL signature: same binding as the grant plus asset and variant, so a rotated link stops serving images. */
export const assetSig = (token: string, version: number, assetId: string, variant: string, exp: number) => mac('asset', token, version, assetId, variant, exp);
export function verifyAssetSig(sig: string, token: string, version: number, assetId: string, variant: string, exp: number, now = new Date()) {
  return exp * 1000 > now.getTime() && sameMac(sig, assetSig(token, version, assetId, variant, exp));
}

/** share_attempts never stores the token or the IP in clear (D-290). */
export const limiterHash = (kind: 'token' | 'ip', value: string) => mac('limiter', kind, value);

/** Share columns for a new board (createBoard, import). Inputs are already validated by the contracts. */
export async function initialShareColumns({ access, password }: { access: Access; password?: string | null }): Promise<{
  access: Access;
  shareToken: string | null;
  sharePasswordHash: string | null;
  sharedAt: Date | null;
}> {
  if (access === 'owner') return { access, shareToken: null, sharePasswordHash: null, sharedAt: null };
  if (access === 'password' && !password) throw new Error('initialShareColumns: password required for access=password');
  return {
    access,
    shareToken: newShareToken(),
    sharePasswordHash: access === 'password' ? await hashSharePassword(password!) : null,
    sharedAt: new Date(),
  };
}
