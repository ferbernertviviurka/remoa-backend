import { describe, expect, it } from 'vitest';
import { takeUploadSlot, UPLOAD_SIGN_PER_HOUR } from './rate-limit';

describe('upload sign rate limit (P-019)', () => {
  it('blocks the 61st sign in an hour with rate_limited (429), per user, and recovers', () => {
    const t = 1_000_000;
    for (let i = 0; i < UPLOAD_SIGN_PER_HOUR; i++) expect(takeUploadSlot('u1', t + i).ok).toBe(true);
    const r = takeUploadSlot('u1', t + 100);
    expect(r.ok === false && r.error.code).toBe('rate_limited');
    expect(takeUploadSlot('u2', t + 100).ok).toBe(true);
    expect(takeUploadSlot('u1', t + 3_600_001 + UPLOAD_SIGN_PER_HOUR).ok).toBe(true);
  });
});
