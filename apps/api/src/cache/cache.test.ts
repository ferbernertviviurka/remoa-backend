// G21/F29 T6 (FR-38, FR-46 a–d): unit tests of the API cache. No database: fn is a counter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cacheEnv, env } from '@remoa/config';
import { cacheTags } from '@remoa/contracts';
import { createLogger } from '@remoa/log';
import type { Env } from '../app';
import { cached, cacheStats, invalidate, resetCache, type GlobalCacheDef, type UserCacheDef } from '.';
import { internalCacheRoutes } from './routes';
import * as store from './store';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const stats: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'stats', ttl: 'live', tags: ({ userId }) => [cacheTags.user(userId, 'stats')] };
const plans: GlobalCacheDef<object> = { scope: 'global', name: 'cfg', ttl: 'long', tags: () => ['config:plans'] };

let n = 0;
const compute = (label: string) => async () => `${label}#${++n}`;
const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

beforeEach(() => {
  resetCache();
  n = 0;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe('cached (L1, in process)', () => {
  it('hits within the TTL and is fresh right after invalidate (FR-46a)', async () => {
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
    await invalidate('review.answered', { userId: A });
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#2');
    expect(cacheStats().caches.stats).toMatchObject({ hit: 1, miss: 2 });
  });

  it('expires with the TTL profile (FR-46b) and counts it as stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await cached(stats, { userId: A }, compute('a'));
    vi.advanceTimersByTime(29_000);
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
    vi.advanceTimersByTime(1_001);
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#2');
    expect(cacheStats().caches.stats?.stale).toBe(1);
  });

  it('isolates users: userId in the key, and one user’s event leaves the other’s entry (FR-34, FR-46c)', async () => {
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
    expect(await cached(stats, { userId: B }, compute('b'))).toBe('b#2');
    await invalidate('review.answered', { userId: A });
    expect(await cached(stats, { userId: B }, compute('b'))).toBe('b#2');
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#3');
  });

  it('refuses a user def whose tags are not of the ctx user', async () => {
    const leaky: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'leak', ttl: 'live', tags: () => [cacheTags.user(B, 'stats')] };
    await expect(cached(leaky, { userId: A }, compute('x'))).rejects.toThrow(/not of the ctx user/);
  });

  it('a user entry may carry a global tag: config.changed drops every user’s entitlements', async () => {
    const ent: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'ent', ttl: 'medium', tags: ({ userId }) => [cacheTags.user(userId, 'ent'), 'config:plans'] };
    await cached(ent, { userId: A }, compute('a'));
    await cached(ent, { userId: B }, compute('b'));
    expect((await invalidate('config.changed', {})).dropped).toBe(2);
  });

  it('account.deleted drops every entry of that user (umbrella tag)', async () => {
    const maps: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'maps', ttl: 'short', tags: ({ userId }) => [cacheTags.user(userId, 'maps')] };
    await cached(maps, { userId: A }, compute('m'));
    await cached(stats, { userId: A }, compute('s'));
    expect((await invalidate('account.deleted', { userId: A })).dropped).toBe(2);
  });

  it('CACHE_DISABLED=1 bypasses: same answer, fn runs every time (FR-38, FR-46d)', async () => {
    vi.stubEnv('CACHE_DISABLED', '1');
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#2');
    expect(store.size().entries).toBe(0);
    expect(cacheStats().caches.stats?.bypass).toBe(2);
  });

  it('CACHE_VERSION is in the key: bumping it misses (FR-38)', async () => {
    expect(cacheEnv({}).version).toBe('1');
    await cached(plans, {}, compute('p'));
    vi.stubEnv('CACHE_VERSION', '2');
    expect(await cached(plans, {}, compute('p'))).toBe('p#2');
  });

  it('dedupes concurrent calls into one computation', async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<string>((r) => (release = () => r('v'))));
    const all = Promise.all([cached(stats, { userId: A }, slow), cached(stats, { userId: A }, slow), cached(stats, { userId: A }, slow)]);
    release();
    expect(await all).toEqual(['v', 'v', 'v']);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('a value computed while an invalidate happened is not stored (no pre-write data)', async () => {
    let release!: () => void;
    const p = cached(stats, { userId: A }, () => new Promise<string>((r) => (release = () => r('old'))));
    await invalidate('card.changed', { userId: A });
    release();
    expect(await p).toBe('old');
    expect(await cached(stats, { userId: A }, compute('a'))).toBe('a#1');
  });

  it('does not store errors: thrown or Result ok:false', async () => {
    await expect(cached(stats, { userId: A }, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await cached(stats, { userId: A }, async () => ({ ok: false }));
    expect(store.size().entries).toBe(0);
  });

  it('LRU: a value over the entry limit is not stored', async () => {
    await cached(plans, {}, async () => 'x'.repeat(store.LIMITS.entryBytes + 1));
    expect(store.size().entries).toBe(0);
  });
});

describe('types (FR-32/FR-34, architecture b): checked by `tsc` on this file', () => {
  it('no TTL, no userId in a user cache, user tags in a global cache, raw seconds → compile errors', () => {
    // @ts-expect-error ttl is required
    const noTtl: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'x', tags: ({ userId }) => [cacheTags.user(userId, 'stats')] };
    // @ts-expect-error a user cache needs userId in its context
    const noUser: UserCacheDef<{ id: string }> = { scope: 'user', name: 'x', ttl: 'live', tags: () => [cacheTags.user(A, 'stats')] };
    // @ts-expect-error a global cache cannot carry user tags
    const leaky: GlobalCacheDef<object> = { scope: 'global', name: 'g', ttl: 'long', tags: () => [cacheTags.user(A, 'stats')] };
    // @ts-expect-error ttl is a named profile, not seconds
    const raw: GlobalCacheDef<object> = { scope: 'global', name: 'g', ttl: 30, tags: () => ['config:plans'] };
    // @ts-expect-error a user cache needs at least one tag
    const noTags: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'x', ttl: 'live', tags: () => [] };
    // @ts-expect-error calling a user cache without userId in ctx
    const call = () => cached(stats, {}, compute('x'));
    expect([noTtl, noUser, leaky, raw, noTags, call].length).toBe(6);
  });
});

describe('store LRU', () => {
  it('evicts the least recently used past the entry limit', () => {
    const old = store.LIMITS.entries;
    store.LIMITS.entries = 2;
    try {
      store.set('a', 1, 1000, []);
      store.set('b', 2, 1000, []);
      store.get('a');
      store.set('c', 3, 1000, []);
      expect(store.get('b').state).toBe('miss');
      expect(store.get('a').state).toBe('hit');
    } finally {
      store.LIMITS.entries = old;
    }
  });
});

describe('invalidate → web', () => {
  it('forwards only web tags, in the background', async () => {
    await invalidate('review.answered', { userId: A });
    expect(fetchMock).not.toHaveBeenCalled();
    await invalidate('blog.changed', { slugs: ['s'] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env().revalidateUrl);
    expect(JSON.parse(String(init.body)).tags).toEqual(['blog', 'landing', 'sitemap', 'feed', 'blog:post:s']);
  });

  it('never throws on a bad context', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof createLogger>;
    await expect(invalidate('review.answered', { userId: '' }, log)).resolves.toEqual({ tags: [], dropped: 0 });
    expect(log.error).toHaveBeenCalled();
  });
});

describe('POST /v1/internal/cache/invalidate', () => {
  const app = new Hono<Env>()
    .use(async (c, next) => {
      c.set('log', createLogger({ requestId: 't' }));
      await next();
    })
    .route('/v1/internal/cache', internalCacheRoutes);
  const call = (auth: string | null, body: unknown) =>
    app.request('/v1/internal/cache/invalidate', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) }, body: JSON.stringify(body) });
  const ok = () => `Bearer ${env().revalidateSecret}`;

  it('401 without the exact Bearer', async () => {
    for (const a of [null, '', `Bearer ${env().revalidateSecret}x`, env().revalidateSecret]) expect((await call(a, { tags: ['config:plans'] })).status).toBe(401);
    expect((await app.request('/v1/internal/cache/stats')).status).toBe(401);
  });

  it('drops by event or by catalog tags; 422 on unknown tags or a context that yields none', async () => {
    await cached(stats, { userId: A }, compute('a'));
    const r = await call(ok(), { event: 'card.changed', ctx: { userId: A } });
    expect(r.status).toBe(200);
    expect((await r.json()).data.dropped).toBe(1);
    expect((await call(ok(), { tags: ['config:plans', `user:${A}:stats`] })).status).toBe(200);
    expect((await call(ok(), { tags: ['whatever'] })).status).toBe(422);
    expect((await call(ok(), { event: 'card.changed', ctx: {} })).status).toBe(422);
    expect((await call(ok(), { event: 'nope' })).status).toBe(422);
    const s = await app.request('/v1/internal/cache/stats', { headers: { authorization: ok() } });
    expect((await s.json()).data.caches.stats.miss).toBe(1);
  });
});
