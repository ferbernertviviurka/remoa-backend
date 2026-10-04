import { describe, expect, it } from 'vitest';
import { ADMIN_RATE, takeAdminSlot } from './rate-limit';

describe('takeAdminSlot (FR-21)', () => {
  it('reads and actions have separate per-admin budgets that reset after a minute', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ADMIN_RATE.action; i++) expect(takeAdminSlot('adm-a', 'action', t0)).toBe(true);
    expect(takeAdminSlot('adm-a', 'action', t0)).toBe(false);
    expect(takeAdminSlot('adm-a', 'read', t0)).toBe(true); // reads unaffected
    expect(takeAdminSlot('adm-b', 'action', t0)).toBe(true); // other admin unaffected
    expect(takeAdminSlot('adm-a', 'action', t0 + 60_001)).toBe(true);
  });
});
