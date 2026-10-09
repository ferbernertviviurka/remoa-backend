import { afterAll, describe, expect, it, vi } from 'vitest';
import { presignGet } from './storage';
afterAll(() => vi.unstubAllEnvs());
describe('actual AWS SDK private download signing', () => {
  it('uses short TTL and preserves the legacy default without sending a network request', async () => {
    for (const key of ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'])
      vi.stubEnv(key, key === 'S3_ENDPOINT' ? 'https://localhost:9000' : 'synthetic');
    expect(new URL(await presignGet('private/page.png', 300)).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new URL(await presignGet('legacy.pdf')).searchParams.get('X-Amz-Expires')).toBe('3600');
    for (const ttl of [0, -1, 3601, 1.5, NaN]) expect(() => presignGet('private/page.png', ttl)).toThrow('storage_invalid_download_ttl');
  });
});
