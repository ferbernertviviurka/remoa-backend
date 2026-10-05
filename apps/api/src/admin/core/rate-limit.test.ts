import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AdminEnv } from './require-admin';
import { ADMIN_RATE, adminRateLimit, takeAdminSlot } from './rate-limit';

describe('takeAdminSlot (FR-21)', () => {
  it('reads and actions have separate per-admin budgets that reset after a minute', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < ADMIN_RATE.action; i++) expect(takeAdminSlot('adm-a', 'action', t0)).toBe(true);
    expect(takeAdminSlot('adm-a', 'action', t0)).toBe(false);
    expect(takeAdminSlot('adm-a', 'read', t0)).toBe(true); // reads unaffected
    expect(takeAdminSlot('adm-b', 'action', t0)).toBe(true); // other admin unaffected
    expect(takeAdminSlot('adm-a', 'action', t0 + 60_001)).toBe(true);
  });

  it('reads cap at 600/min, actions at 30/min', () => {
    expect(ADMIN_RATE).toEqual({ read: 600, action: 30 });
    for (let i = 0; i < 600; i++) expect(takeAdminSlot('adm-r', 'read', 5)).toBe(true);
    expect(takeAdminSlot('adm-r', 'read', 5)).toBe(false);
  });

  it('GET /admin/me is never throttled; other reads still are', async () => {
    const app = new Hono<AdminEnv>()
      .use('*', async (c, next) => { c.set('userId', 'adm-me'); await next(); })
      .use('*', adminRateLimit)
      .get('/v1/admin/me', (c) => c.json({ ok: true }))
      .get('/v1/admin/audit', (c) => c.json({ ok: true }));
    for (let i = 0; i < 700; i++) expect((await app.request('/v1/admin/me')).status).toBe(200);
    for (let i = 0; i < 600; i++) expect((await app.request('/v1/admin/audit')).status).toBe(200);
    expect((await app.request('/v1/admin/audit')).status).toBe(429);
    expect((await app.request('/v1/admin/me')).status).toBe(200);
  });
});
