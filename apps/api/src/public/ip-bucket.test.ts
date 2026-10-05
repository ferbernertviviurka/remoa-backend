import { describe, expect, it, vi } from 'vitest';
import { ipBucket } from './shared';

describe('ipBucket (D-543)', () => {
  it('IPv6 = its /64, however written; IPv4 and mapped IPv4 = the IPv4', () => {
    expect(ipBucket('2001:db8:a:1::5')).toBe('2001:db8:a:1::/64');
    expect(ipBucket('2001:0db8:000a:0001:ffff:0:0:abcd')).toBe('2001:db8:a:1::/64');
    expect(ipBucket('2001:db8::1:2:3:4:5')).toBe('2001:db8:0:1::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('unknown')).toBe('unknown');
  });
});

describe('unlock gate (D-543)', () => {
  it('61st unlock from the same /64 in a minute is 429 before any DB work', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    const { sharedRoutes } = await import('../routes/public');
    const app = sharedRoutes();
    const hit = (n: number) => app.request('/not-a-token/unlock', { method: 'POST', body: '{"password":"x"}', headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:77:1::${n.toString(16)}` } });
    for (let i = 1; i <= 60; i++) expect((await hit(i)).status).toBe(404);
    expect((await hit(61)).status).toBe(429);
    vi.unstubAllEnvs();
  });
});
