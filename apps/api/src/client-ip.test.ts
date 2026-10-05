import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { takeLookupSlot } from './routes/referral';
import { CLIENT_IP_HEADER, PROXY_SECRET_HEADER, clientIp } from './client-ip';

const app = new Hono().get('/', (c) => c.text(clientIp(c)));
const socket = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
const ip = async (headers: Record<string, string>, env: object | null = socket('198.51.100.7')) => (await app.request('/', { headers }, env ?? undefined)).text();
const SECRET = 'proxy-secret-for-tests-0123456789';

describe('clientIp (D-537)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ignores spoofed forwarded headers by default: the socket address wins', async () => {
    vi.stubEnv('PROXY_SHARED_SECRET', SECRET);
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    for (const h of <Record<string, string>[]>[{ 'x-forwarded-for': '1.2.3.4' }, { 'cf-connecting-ip': '1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }, { [CLIENT_IP_HEADER]: '1.2.3.4' }])
      expect(await ip(h)).toBe('198.51.100.7');
    expect(await ip({ [CLIENT_IP_HEADER]: '1.2.3.4', [PROXY_SECRET_HEADER]: 'wrong' })).toBe('198.51.100.7');
    expect(await ip({ [CLIENT_IP_HEADER]: '1.2.3.4', [PROXY_SECRET_HEADER]: `${SECRET}x` })).toBe('198.51.100.7');
  });

  it('trusts x-remoa-client-ip only with the shared secret, and only if it is an IP', async () => {
    vi.stubEnv('PROXY_SHARED_SECRET', SECRET);
    expect(await ip({ [CLIENT_IP_HEADER]: '1.2.3.4', [PROXY_SECRET_HEADER]: SECRET })).toBe('1.2.3.4');
    expect(await ip({ [CLIENT_IP_HEADER]: '2001:db8::1', [PROXY_SECRET_HEADER]: SECRET })).toBe('2001:db8::1');
    expect(await ip({ [CLIENT_IP_HEADER]: 'not-an-ip', [PROXY_SECRET_HEADER]: SECRET })).toBe('198.51.100.7');
    vi.stubEnv('PROXY_SHARED_SECRET', ''); // unset secret: nothing matches, not even an empty header
    expect(await ip({ [CLIENT_IP_HEADER]: '1.2.3.4', [PROXY_SECRET_HEADER]: '' })).toBe('198.51.100.7');
  });

  it('TRUSTED_PROXY_HOPS takes the entry that many hops from the right of x-forwarded-for', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    expect(await ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).toBe('203.0.113.9'); // client-prepended 6.6.6.6 is ignored
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    expect(await ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' })).toBe('203.0.113.9');
    expect(await ip({ 'x-forwarded-for': '10.0.0.2' })).toBe('198.51.100.7'); // fewer entries than hops: socket
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'x');
    expect(await ip({ 'x-forwarded-for': '203.0.113.9' })).toBe('198.51.100.7');
  });

  it('no socket (app.request without env) is "unknown", never a throw', async () => {
    expect(await ip({ 'x-forwarded-for': '1.2.3.4' }, null)).toBe('unknown');
  });

  it('rate-limit key: rotating a spoofed XFF does not get past the limit; the trusted pair does', async () => {
    const lim = new Hono().get('/', (c) => c.text(takeLookupSlot(clientIp(c)) ? 'ok' : 'limited'));
    const hit = async (h: Record<string, string>) => (await lim.request('/', { headers: h }, socket('192.0.2.200'))).text();
    vi.stubEnv('PROXY_SHARED_SECRET', SECRET);
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await hit({ 'x-forwarded-for': `203.0.113.${i}` }));
    expect(results).toContain('limited');
    expect(await hit({ [CLIENT_IP_HEADER]: '203.0.113.250', [PROXY_SECRET_HEADER]: SECRET })).toBe('ok');
  });
});
