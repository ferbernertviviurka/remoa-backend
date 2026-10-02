import { describe, expect, it } from 'vitest';
import { SHARE_LIMITS, shareTokenSchema } from '@remoa/contracts';

process.env.SHARE_SECRET ||= 'test-share-secret-test-share-secret';
const c = await import('./crypto');

describe('F17 share crypto', () => {
  it('tokens are 43-char base64url and unique', () => {
    const t = c.newShareToken();
    expect(shareTokenSchema.safeParse(t).success).toBe(true);
    expect(c.newShareToken()).not.toBe(t);
  });

  it('scrypt hash: format, verify, salted, malformed or unknown version is false', async () => {
    const h = await c.hashSharePassword('segredo1');
    expect(h).toMatch(/^scrypt\$v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await c.hashSharePassword('segredo1')).not.toBe(h);
    expect(await c.verifySharePassword('segredo1', h)).toBe(true);
    expect(await c.verifySharePassword('segredo2', h)).toBe(false);
    expect(await c.verifySharePassword('segredo1', h.replace('$v1$', '$v9$'))).toBe(false);
    expect(await c.verifySharePassword('segredo1', 'plain')).toBe(false);
    expect(await c.verifySharePassword('segredo1', `${h.slice(0, -4)}AAAA`)).toBe(false);
  });

  it('grant: bound to token and version, expires after accessTtlSeconds, tamper-proof', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const g = c.signGrant('tok', 3, now);
    expect(g.expiresAt.getTime() - now.getTime()).toBe(SHARE_LIMITS.accessTtlSeconds * 1000);
    expect(c.verifyGrant(g.value, 'tok', 3, now)).toBe(true);
    expect(c.verifyGrant(g.value, 'tok', 4, now)).toBe(false);
    expect(c.verifyGrant(g.value, 'other', 3, now)).toBe(false);
    expect(c.verifyGrant(g.value, 'tok', 3, new Date(g.expiresAt.getTime() + 1))).toBe(false);
    const [tag, exp, sig] = g.value.split('.');
    expect(c.verifyGrant(`${tag}.${Number(exp) + 3600}.${sig}`, 'tok', 3, now)).toBe(false);
    for (const bad of [null, '', 'g1', 'g1.x.y', `g2.${exp}.${sig}`]) expect(c.verifyGrant(bad, 'tok', 3, now)).toBe(false);
  });

  it('asset signature: per asset and variant, expires', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const s = c.assetSig('tok', 1, 'asset', 'w800', exp);
    expect(c.verifyAssetSig(s, 'tok', 1, 'asset', 'w800', exp)).toBe(true);
    expect(c.verifyAssetSig(s, 'tok', 1, 'asset', 'w1600', exp)).toBe(false);
    expect(c.verifyAssetSig(s, 'tok', 2, 'asset', 'w800', exp)).toBe(false);
    expect(c.verifyAssetSig(s, 'tok', 1, 'asset', 'w800', exp, new Date((exp + 1) * 1000))).toBe(false);
  });

  it('initialShareColumns: owner has nothing; public has a token; password also a hash', async () => {
    expect(await c.initialShareColumns({ access: 'owner' })).toEqual({ access: 'owner', shareToken: null, sharePasswordHash: null, sharedAt: null });
    const pub = await c.initialShareColumns({ access: 'public', password: null });
    expect(pub.shareToken).toHaveLength(43);
    expect(pub.sharePasswordHash).toBeNull();
    expect(pub.sharedAt).toBeInstanceOf(Date);
    const pw = await c.initialShareColumns({ access: 'password', password: 'segredo1' });
    expect(await c.verifySharePassword('segredo1', pw.sharePasswordHash!)).toBe(true);
    await expect(c.initialShareColumns({ access: 'password' })).rejects.toThrow();
  });

  it('limiter hashes never contain the input', () => {
    expect(c.limiterHash('ip', '10.0.0.1')).not.toContain('10.0.0.1');
    expect(c.limiterHash('ip', 'x')).not.toBe(c.limiterHash('token', 'x'));
  });
});
