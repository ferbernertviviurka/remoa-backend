import { describe, expect, it } from 'vitest';
import { cacheEvents, cacheEventTags, cacheTags, cacheTtl, isWebTag, tagScope, tagsFor, userTagKinds, type CacheEvent, type CacheEventCtx } from './cache';

const U = '11111111-1111-4111-8111-111111111111';
/** One full context per event: every optional field filled, so every branch of the map runs. */
const sample: { [E in CacheEvent]: CacheEventCtx[E] } = {
  'map.changed': { userId: U, mapId: 'm1' },
  'card.changed': { userId: U, mapId: 'm1' },
  'review.answered': { userId: U },
  'calendar.changed': { userId: U },
  'notification.changed': { userId: U },
  'prefs.changed': { userId: U },
  'profile.changed': { userId: U },
  'plan.changed': { userId: U },
  'grant.changed': { userId: U },
  'referral.changed': { userId: U },
  'support.changed': { userId: U },
  'account.deleted': { userId: U },
  'admin.action': { userId: U },
  'blog.changed': { slugs: ['a'], categorySlugs: ['c'] },
  'legal.changed': { doc: 'terms' },
  'config.changed': {},
  'catalog.changed': {},
};

describe('cache catalog (G21 T6, FR-40/FR-46e)', () => {
  it('every event has at least one tag, and every tag has a scope', () => {
    expect(cacheEvents.sort()).toEqual(Object.keys(sample).sort());
    for (const e of cacheEvents) {
      const tags = tagsFor(e, sample[e] as never);
      expect(tags.length, e).toBeGreaterThan(0);
      for (const t of tags) expect(tagScope(t), `${e} → ${t}`).not.toBeNull();
    }
  });

  it('user events only produce tags with that userId (FR-34) — except the admin overview', () => {
    for (const e of cacheEvents) {
      const ctx = sample[e] as { userId?: string };
      if (!ctx.userId) continue;
      for (const t of tagsFor(e, sample[e] as never)) if (t !== 'admin:overview') expect(t.startsWith(`user:${U}`), `${e} → ${t}`).toBe(true);
    }
  });

  it('frequent review.answered does not drop the map list or entitlements (FR-44)', () => {
    const t = cacheEventTags['review.answered']({ userId: U });
    expect(t).not.toContain(cacheTags.user(U, 'maps'));
    expect(t).not.toContain(cacheTags.user(U, 'ent'));
  });

  it('scopes: user tags, API-only globals and web tags (the F27 blog names stay)', () => {
    for (const k of userTagKinds) expect(tagScope(cacheTags.user(U, k))).toBe('user');
    expect(tagScope(cacheTags.map(U, 'm'))).toBe('user');
    expect(tagScope(cacheTags.userAll(U))).toBe('user');
    expect(tagScope('admin:overview')).toBe('global');
    expect(isWebTag('admin:overview')).toBe(false);
    for (const t of ['blog', 'landing', 'sitemap', 'feed', 'pricing', 'blog:post:x', 'blog:category:y', 'legal:terms', 'legal:privacy']) expect(isWebTag(t), t).toBe(true);
    for (const t of ['user:', 'user:a:nope', 'blog:cat:x', 'legal:other', 'random', 'user:a:map:']) expect(tagScope(t), t).toBeNull();
  });

  it('ids with ":" are refused (no prefix collisions)', () => {
    expect(() => cacheTags.user('a:b', 'maps')).toThrow();
    expect(() => cacheTags.blogPost('')).toThrow();
  });

  it('TTL profiles are positive seconds', () => {
    for (const v of Object.values(cacheTtl)) expect(v).toBeGreaterThan(0);
  });
});
