import { describe, expect, it, vi } from 'vitest';
import { httpErrorBodySchema } from '@remoa/contracts';
import { createApp } from './app';

// uuid: with a database the user id reaches `where user_id = $1` (uuid column) in the first statement of run() (G21 D-990)
const USER = '00000000-0000-4000-8000-000000000001';
const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === 'good' ? USER : null) });

describe('api', () => {
  it('health is public and echoes a request id', async () => {
    const res = await app.request('/health', { headers: { 'x-request-id': 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('r-1');
    const body = await res.json();
    expect(body.email).toMatchObject({ configured: expect.any(Boolean), provider: expect.stringMatching(/^(console|resend)$/) }); // G18, no secrets
    expect(Object.keys(body.ai).sort()).toEqual(['model', 'status']); // G22: no key, no account usage, no problem texts (P-619)
    expect(body.ai.status).toMatch(/^(ok|degraded|off|mock|pending)$/);
  });

  it('D-1123: /health is 503 until the boot warm-up is done, then 200 (Railway healthcheck)', async () => {
    let warm = false;
    const booting = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async () => null, ready: () => warm });
    const before = await booting.request('/health');
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ ok: false, warming: true });
    warm = true;
    expect((await booting.request('/health')).status).toBe(200);
  });

  it('CORS: every WEB_ORIGIN in the list is echoed with credentials; others are not; timing headers stay exposed', async () => {
    const multi = createApp({ webOrigin: ['https://remoa.com.br', 'https://www.remoa.com.br'], verifyToken: async () => null });
    for (const origin of ['https://remoa.com.br', 'https://www.remoa.com.br']) {
      const res = await multi.request('/v1/me', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const get = await multi.request('/v1/me', { headers: { origin } });
      expect(get.headers.get('access-control-allow-origin')).toBe(origin);
      expect(get.headers.get('access-control-expose-headers')).toBe('server-timing,x-remoa-queries');
    }
    for (const origin of ['https://evil.example', 'https://remoa.com.br.evil.example', 'null']) {
      const res = await multi.request('/v1/me', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('rejects /v1 without a valid token using the contracts error body', async () => {
    for (const headers of [{}, { authorization: 'Bearer bad' }] as Record<string, string>[]) {
      const res = await app.request('/v1/me', { headers });
      expect(res.status).toBe(401);
      expect(httpErrorBodySchema.parse(await res.json()).error.code).toBe('unauthorized');
    }
  });

  it('resolves the user from the bearer token', async () => {
    const res = await app.request('/v1/me', { headers: { authorization: 'Bearer good' } });
    expect(await res.json()).toEqual({ ok: true, data: { userId: USER } });
  });

  it('unknown routes return not_found', async () => {
    expect((await app.request('/nope')).status).toBe(404);
  });

  it('logs 4xx/5xx with the typed error code and message, never the token (D-582)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    try {
      await app.request('/v1/me', { headers: { authorization: 'Bearer bad-secret-token', 'x-request-id': 'r-log' } });
    } finally {
      spy.mockRestore();
    }
    const line = JSON.parse(lines.find((l) => l.includes('"r-log"')) ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'warn', msg: 'request', method: 'GET', path: '/v1/me', status: 401, code: 'unauthorized', message: 'invalid or missing token' });
    expect(typeof line.ms).toBe('number');
    expect(lines.join('')).not.toContain('bad-secret-token');
  });

  it('never logs a blog preview token (F27 T11)', async () => {
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
    try {
      await app.request('/v1/public/blog/preview/eyJwIjoieCJ9.segredo-do-preview');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(lines.join('')).toContain('/v1/public/blog/preview/:token');
    expect(lines.join('')).not.toContain('segredo-do-preview');
  });
});
