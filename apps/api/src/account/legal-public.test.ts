import { describe, expect, it, vi } from 'vitest';

vi.mock('@remoa/config', () => ({ env: () => ({ legalTermsVersion: '2026-10-01', legalPrivacyVersion: '2026-10-02' }) }));
vi.mock('../db', () => ({ dbm: async () => ({}) }));

import { publicLegalRoutes } from './legal';

describe('GET /versions (P-416)', () => {
  it('returns the configured versions with a short cache', async () => {
    const res = await publicLegalRoutes.request('/versions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { termsVersion: '2026-10-01', privacyVersion: '2026-10-02' } });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
