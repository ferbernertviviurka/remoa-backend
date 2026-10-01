import { describe, expect, it } from 'vitest';
import { httpErrorBodySchema } from '@remoa/contracts';
import { createApp } from './app';

const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (t === 'good' ? 'user-1' : null) });

describe('api', () => {
  it('health is public and echoes a request id', async () => {
    const res = await app.request('/health', { headers: { 'x-request-id': 'r-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('r-1');
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
});
