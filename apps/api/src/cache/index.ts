// G21/F29 T6 (D-979/D-980, FR-32–FR-46): the API half of the cache. The only cache API of apps/api:
//   cached(def, ctx, fn)    L1 in process: TTL from a named profile, userId in key and tag for user data, CACHE_VERSION in the key,
//                           CACHE_DISABLED=1 bypass, in-flight dedupe, hit/miss/stale in Server-Timing and in cacheStats().
//   invalidate(event, ctx)  the one door: drops the event's tags here (after the commit, before the response) and forwards the
//                           web tags to POST /api/revalidate in the background (never awaited, never throws).
// Catalog (events, tags, TTLs): @remoa/contracts cache.ts. Storage: ./store.ts (Redis later, Q-071).
import { cacheEnv } from '@remoa/config';
import { cacheTags, cacheTtl, isCacheTag, isWebTag, tagScope, tagsFor, type CacheEvent, type CacheEventCtx, type CacheTag, type CacheTtl, type GlobalTag, type UserTag } from '@remoa/contracts';
import { createLogger, type Logger } from '@remoa/log';
import { perfStore } from '../perf';
import { revalidateWeb } from './revalidate-web';
import * as store from './store';

type KeyPart = string | number | boolean | null;

/**
 * Per-user cache: ctx must carry the userId (type), every user tag must be that user's (checked), the key always includes it.
 * A global tag may ride along so a global event drops every user's entry (e.g. `config:plans` on entitlements).
 */
export type UserCacheDef<C extends { userId: string }> = {
  scope: 'user';
  /** Short and unique (`ent`, `maps`, `stats`…): the key prefix and the Server-Timing / stats name. */
  name: string;
  ttl: CacheTtl;
  tags: (ctx: C) => [UserTag, ...CacheTag[]];
  /** Extra key parts besides the userId (e.g. a date range). */
  key?: (ctx: C) => KeyPart[];
};
/** Shared, non-personal data (plan definitions, catalog, admin overview). */
export type GlobalCacheDef<C> = { scope: 'global'; name: string; ttl: CacheTtl; tags: (ctx: C) => [GlobalTag, ...GlobalTag[]]; key?: (ctx: C) => KeyPart[] };

type Stat = { hit: number; miss: number; stale: number; bypass: number };
const stats = new Map<string, Stat>();
const inflight = new Map<string, { p: Promise<unknown>; tags: readonly string[] }>();

function count(name: string, state: keyof Stat, ms: number) {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { hit: 0, miss: 0, stale: 0, bypass: 0 }));
  s[state]++;
  const p = perfStore(); // FR-39: `cache-<name>-<state>;dur=` (a miss carries the compute time)
  if (p) p.marks.set(`cache-${name}-${state}`, (p.marks.get(`cache-${name}-${state}`) ?? 0) + ms);
}

/** Result-style values with ok:false are never stored (an error must not stick for a whole TTL). */
const cacheable = (v: unknown) => !(typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false);

export function cached<C extends { userId: string }, T>(def: UserCacheDef<C>, ctx: C, fn: () => Promise<T>): Promise<T>;
export function cached<C, T>(def: GlobalCacheDef<C>, ctx: C, fn: () => Promise<T>): Promise<T>;
export async function cached<C, T>(def: UserCacheDef<C & { userId: string }> | GlobalCacheDef<C>, ctx: C, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const env = cacheEnv();
  if (env.disabled) {
    count(def.name, 'bypass', 0);
    return fn();
  }
  let tags: string[] = def.tags(ctx as C & { userId: string });
  const parts = def.key?.(ctx as C & { userId: string }) ?? [];
  let key: string;
  if (def.scope === 'user') {
    const userId = (ctx as { userId: string }).userId;
    const mine = cacheTags.userAll(userId);
    // FR-34: a user entry can only be dropped by its own user's tags; a wrong tag is a bug, never a silent leak
    for (const t of tags) if (tagScope(t) === 'user' && t !== mine && !t.startsWith(`${mine}:`)) throw new Error(`cache ${def.name}: tag ${t} is not of the ctx user`);
    tags = [...tags, mine];
    key = `v${env.version}:${def.name}:${userId}:${JSON.stringify(parts)}`;
  } else key = `v${env.version}:${def.name}:${JSON.stringify(parts)}`;

  const found = store.get(key);
  if (found.state === 'hit') {
    count(def.name, 'hit', performance.now() - t0);
    return found.value as T;
  }
  const flying = inflight.get(key);
  if (flying) {
    count(def.name, 'hit', 0); // deduped: one computation for concurrent callers
    return flying.p as Promise<T>;
  }
  const me = { p: fn(), tags };
  inflight.set(key, me);
  try {
    const value = await me.p;
    // stored only if no invalidate() touched these tags while it was computing (else it may hold pre-write data)
    if (inflight.get(key) === me && cacheable(value)) store.set(key, value, cacheTtl[def.ttl] * 1000, tags);
    return value as T;
  } finally {
    if (inflight.get(key) === me) inflight.delete(key);
    count(def.name, found.state, performance.now() - t0);
  }
}

function dropTags(tags: readonly CacheTag[], log: Logger) {
  const dropped = store.deleteTags(tags);
  const set = new Set<string>(tags);
  for (const [k, f] of inflight) if (f.tags.some((t) => set.has(t))) inflight.delete(k);
  const web = tags.filter(isWebTag);
  // background: the TTL is the safety net if the web is down (FR-11: no external call on the critical path)
  if (web.length) void revalidateWeb(web, log).catch(() => undefined);
  return dropped;
}

/**
 * The one door (FR-40). Call it after the write committed — `await run(...)` returns after COMMIT — and before answering.
 * Never throws: a bad ctx is logged and the TTL covers it.
 */
export async function invalidate<E extends CacheEvent>(event: E, ctx: CacheEventCtx[E], log: Logger = perfStore()?.log ?? createLogger({ requestId: 'no-request' })): Promise<{ tags: CacheTag[]; dropped: number }> {
  let tags: CacheTag[];
  try {
    tags = tagsFor(event, ctx);
    const bad = tags.filter((t) => !isCacheTag(t));
    if (bad.length) throw new Error(`not catalog tags: ${bad.join(', ')}`);
  } catch (e) {
    log.error('cache invalidate failed', { event, error: e instanceof Error ? e.message : String(e) });
    return { tags: [], dropped: 0 };
  }
  return { tags, dropped: dropTags(tags, log) };
}

/** Only for POST /v1/internal/cache/invalidate (cron, manual SQL): tags already checked against the catalog. */
export async function invalidateTags(tags: CacheTag[], log: Logger) {
  return { tags, dropped: dropTags(tags, log) };
}

/** FR-39: counters since boot, per cache name, with the hit rate (hits / (hits + misses + stale)). */
export function cacheStats() {
  const caches = Object.fromEntries(
    [...stats].map(([name, s]) => {
      const looked = s.hit + s.miss + s.stale;
      return [name, { ...s, hitRate: looked ? Math.round((s.hit / looked) * 1000) / 1000 : null }];
    }),
  );
  return { ...store.size(), caches };
}

/** Tests only. */
export function resetCache() {
  store.clear();
  inflight.clear();
  stats.clear();
}
