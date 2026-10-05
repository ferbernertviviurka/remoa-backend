import { getConnInfo } from '@hono/node-server/conninfo';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Context } from 'hono';

export const CLIENT_IP_HEADER = 'x-remoa-client-ip';
export const PROXY_SECRET_HEADER = 'x-remoa-proxy-secret';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * D-537: the one place that answers "who is the client" (rate limits, audit/IP hashes). Forwarded headers are client-controlled,
 * so they count only through a trusted hop:
 * 1. `x-remoa-client-ip` when `x-remoa-proxy-secret` equals PROXY_SHARED_SECRET (the Next server calling on behalf of a browser);
 * 2. TRUSTED_PROXY_HOPS=n: the entry n hops from the right of x-forwarded-for (each trusted proxy appends what it saw);
 * 3. the socket address. `cf-connecting-ip`/`x-real-ip` are never read: behind Cloudflare, count it as a hop.
 */
export function clientIp(c: Pick<Context, 'req' | 'env'>): string {
  const secret = process.env.PROXY_SHARED_SECRET;
  const given = c.req.header(PROXY_SECRET_HEADER);
  const forwarded = c.req.header(CLIENT_IP_HEADER)?.trim();
  if (secret && given && forwarded && same(given, secret) && isIP(forwarded)) return forwarded;

  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0) {
    const xff = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = xff[xff.length - hops];
    if (ip && isIP(ip)) return ip;
  }

  try {
    return getConnInfo(c as Context).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no node socket (app.request in tests)
  }
}
