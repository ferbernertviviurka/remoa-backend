// F19 FR-21: per-admin throttle on /v1/admin/*. 429 rate_limited (never a denied audit row: it is an authenticated admin).
import { createMiddleware } from 'hono/factory';
import type { AdminEnv } from './require-admin';
import { fail } from './require-admin';

const WINDOW_MS = 60_000;
export const ADMIN_RATE = { read: 120, action: 30 } as const;
const hits = new Map<string, number[]>();

/** ponytail: per-process, in memory; move to the DB/Redis if the API scales out (Q-008). */
export function takeAdminSlot(adminId: string, kind: keyof typeof ADMIN_RATE, now = Date.now()) {
  if (hits.size > 5_000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  const key = `${adminId}|${kind}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= ADMIN_RATE[kind]) { hits.set(key, recent); return false; }
  hits.set(key, [...recent, now]);
  return true;
}

/** Mount after requireAdmin (needs c.get('userId')). GET/HEAD = reads, everything else = actions. */
export const adminRateLimit = createMiddleware<AdminEnv>(async (c, next) => {
  const kind = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'action';
  if (!takeAdminSlot(c.get('userId'), kind)) return fail({ code: 'rate_limited', message: 'too many requests' });
  await next();
});
