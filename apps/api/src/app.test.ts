import { describe, expect, it, vi } from 'vitest';
import { httpErrorBodySchema } from '@remoa/contracts';
import { createApp } from './app';

const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === 'good' ? 'user-1' : null) });

describe('api', () => {
  it('health is public and echoes a request id', async () => {
    const res = await app.request('/health', { headers: { 'x-request-id': 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('r-1');
    expect((await res.json()).email).toMatchObject({ configured: expect.any(Boolean), provider: expect.stringMatching(/^(console|resend)$/) }); // G18, no secrets
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
    expect(await res.json()).toEqual({ ok: true, data: { userId: 'user-1' } });
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
