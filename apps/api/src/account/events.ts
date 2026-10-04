// F13 audit log + rate-limit counter (account_events). Server connection only: the client has SELECT, never INSERT (D-121).
import { createHmac } from 'node:crypto';
import { and, count, eq, gte } from 'drizzle-orm';
import type { AccountEventType } from '@remoa/contracts';
import type { Db, Tx } from '@remoa/db';
import type { Context } from 'hono';
import { dbm } from '../db';
import { clientIp } from '../client-ip';

/** No personal data: a keyed hash of the IP and a coarse user-agent ("Chrome no macOS"). */
export type EventMeta = { ipHash?: string; ua?: string; [k: string]: string | number | boolean | null | undefined };

export async function recordEvent(dbOrTx: Db | Tx, userId: string, type: AccountEventType, meta: EventMeta = {}) {
  const { accountEvents } = await dbm();
  const [row] = await dbOrTx.insert(accountEvents).values({ userId, type, meta }).returning({ id: accountEvents.id });
  return row!.id;
}

/**
 * Events of `type` since `sinceMs`. Accepts an epoch timestamp (Date.now() - 3_600_000) or a window length (3_600_000):
 * values below 1e12 (~2001) are read as "the last N ms", so either call style is safe.
 */
export async function countEvents(userId: string, type: AccountEventType, sinceMs: number) {
  const { db, accountEvents: e } = await dbm();
  const since = new Date(sinceMs >= 1e12 ? sinceMs : Date.now() - sinceMs);
  const [r] = await db.select({ n: count() }).from(e).where(and(eq(e.userId, userId), eq(e.type, type), gte(e.createdAt, since)));
  return r?.n ?? 0;
}

/**
 * Rate limit without a lock: insert first, then count. Concurrent callers each see the others' rows, so at most `limit`
 * get through (a burst may let fewer through, never more). Returns the slot id, or null (slot already released) when over.
 */
export async function takeSlot(userId: string, type: AccountEventType, limit: number, windowMs: number, meta?: EventMeta) {
  const { db } = await dbm();
  const id = await recordEvent(db, userId, type, meta);
  if ((await countEvents(userId, type, windowMs)) <= limit) return id;
  await releaseSlot(id);
  return null;
}

export async function releaseSlot(id: string) {
  const { db, accountEvents } = await dbm();
  await db.delete(accountEvents).where(eq(accountEvents.id, id));
}

// --- request metadata ----------------------------------------------------------------------------
/** "Chrome"/"macOS" from a user-agent, no library: first match wins, so the order matters (Edge and Opera also say Chrome). */
export function parseUserAgent(ua: string | null | undefined): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null };
  const pick = (rules: [RegExp, string][]) => rules.find(([re]) => re.test(ua))?.[1] ?? null;
  return {
    browser: pick([
      [/Edg(e|A|iOS)?\//, 'Edge'],
      [/OPR\/|Opera/, 'Opera'],
      [/SamsungBrowser\//, 'Samsung Internet'],
      [/Firefox\/|FxiOS\//, 'Firefox'],
      [/Chrome\/|CriOS\//, 'Chrome'],
      [/Safari\//, 'Safari'],
    ]),
    os: pick([
      [/iPhone|iPad|iPod/, 'iOS'],
      [/Android/, 'Android'],
      [/CrOS/, 'ChromeOS'],
      [/Windows/, 'Windows'],
      [/Mac OS X|Macintosh/, 'macOS'],
      [/Linux/, 'Linux'],
    ]),
  };
}

/**
 * Meta for an event from request headers. The IP is HMAC'd with AUDIT_HASH_SECRET and dropped when the secret is unset.
 * The IP comes from clientIp (D-537): forwarded headers only through a trusted hop.
 */
export function requestMeta(c: Pick<Context, 'req' | 'env'>): EventMeta {
  const { browser, os } = parseUserAgent(c.req.header('user-agent'));
  const raw = clientIp(c);
  const ip = raw === 'unknown' ? undefined : raw;
  const secret = process.env.AUDIT_HASH_SECRET;
  const meta: EventMeta = {};
  if (browser || os) meta.ua = [browser, os].filter(Boolean).join(' no ');
  if (ip && secret) meta.ipHash = createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
  return meta;
}
