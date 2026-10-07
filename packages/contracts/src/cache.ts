// G21/F29 T6 (CCR-052, D-997/D-998): the one cache catalog shared by the API (L1, in process) and the web (Next Data Cache).
// Domain events → tags, typed tag builders with a scope, named TTL profiles and the "never cache" list. Both halves read only this.
//   scope 'user'   → tag carries the userId (`user:{u}:…`), lives in the API process cache (FR-34)
//   scope 'global' → no user data; the web tags (isWebTag) also live in the web's Data Cache and are forwarded to POST /api/revalidate
import { z } from 'zod';

// Tag strings of the blog are the ones F27 already sends (D-907/D-908): `blog:category:{slug}` and `feed` stay as they are.

/** Named TTL profiles, in seconds (F26 catalog, Q-072 provisional). Every cache picks one; there is no cache without TTL. */
export const cacheTtl = { live: 30, short: 60, medium: 300, long: 3_600, day: 86_400 } as const;
export type CacheTtl = keyof typeof cacheTtl;

/** Per-user tag kinds (`user:{u}:{kind}`); `map` is `user:{u}:map:{m}`, the umbrella `user:{u}` is on every user entry. */
export const userTagKinds = ['ent', 'maps', 'stats', 'review', 'progress', 'calendar', 'notif', 'referral', 'tickets', 'profile'] as const;
export type UserTagKind = (typeof userTagKinds)[number];

export const legalDocs = ['terms', 'privacy'] as const;
export type LegalDoc = (typeof legalDocs)[number];

export type UserTag = `user:${string}`;
/** Global tags; the `web` ones are the ones the web caches (forwarded by invalidate()). */
export type GlobalTag = 'admin:overview' | 'config:plans' | 'config:store' | 'catalog:maps' | WebTag;
export type WebTag = 'blog' | 'landing' | 'sitemap' | 'feed' | `blog:post:${string}` | `blog:category:${string}` | `legal:${LegalDoc}` | 'pricing';
export type CacheTag = UserTag | GlobalTag;

const id = (s: string) => {
  // no ':' inside an id: it would let one tag prefix-collide with another
  if (!s || s.includes(':')) throw new Error(`cache: invalid id in tag: ${JSON.stringify(s)}`);
  return s;
};

/** Tag builders. Use these, never a hand-written string. */
export const cacheTags = {
  user: (userId: string, kind: UserTagKind): UserTag => `user:${id(userId)}:${kind}`,
  map: (userId: string, mapId: string): UserTag => `user:${id(userId)}:map:${id(mapId)}`,
  /** Every user entry carries it: dropping it drops all of that user's entries (account.deleted, admin.action). */
  userAll: (userId: string): UserTag => `user:${id(userId)}`,
  blogPost: (slug: string): WebTag => `blog:post:${id(slug)}`,
  blogCategory: (slug: string): WebTag => `blog:category:${id(slug)}`,
  legal: (doc: LegalDoc): WebTag => `legal:${doc}`,
} as const;

const GLOBAL_API = new Set<string>(['admin:overview', 'config:plans', 'config:store', 'catalog:maps']);
const WEB_FIXED = new Set<string>(['blog', 'landing', 'sitemap', 'feed', 'pricing']);
const USER_RE = new RegExp(`^user:[^:]+(?::(?:${userTagKinds.join('|')})|:map:[^:]+)?$`);
const WEB_RE = new RegExp(`^(?:blog:post:[^:]+|blog:category:[^:]+|legal:(?:${legalDocs.join('|')}))$`);

/** 'user' | 'global' for a catalog tag, null for anything else (so a tag without scope cannot exist). */
export function tagScope(tag: string): 'user' | 'global' | null {
  if (USER_RE.test(tag)) return 'user';
  if (GLOBAL_API.has(tag) || isWebTag(tag)) return 'global';
  return null;
}
export const isWebTag = (tag: string): tag is WebTag => WEB_FIXED.has(tag) || WEB_RE.test(tag);
export const isCacheTag = (tag: string): tag is CacheTag => tagScope(tag) !== null;

type U = { userId: string };
/** Context each event needs. User events always carry the userId. */
export type CacheEventCtx = {
  'map.changed': U & { mapId?: string }; // create, rename, delete, duplicate, import, reorder
  'card.changed': U & { mapId?: string };
  'review.answered': U;
  'question.changed': U & { mapId?: string }; // question bank: generate, archive (F32)
  'summary.changed': U & { mapId?: string }; // map summary saved or pruned (F32)
  'challenge.finished': U; // AI challenge session, attempt or score (F32)
  'calendar.changed': U; // event or label, reminders job
  'notification.changed': U;
  'prefs.changed': U;
  'profile.changed': U; // profile, institution, onboarding, account flags shown by /v1/account/me
  'plan.changed': U; // Stripe webhook, checkout, cancel
  'grant.changed': U; // manual grant or its expiry
  'referral.changed': U;
  'support.changed': U;
  'account.deleted': U;
  'admin.action': { userId?: string }; // the affected user, when there is one
  'blog.changed': { slugs?: string[]; categorySlugs?: string[] };
  'legal.changed': { doc: LegalDoc };
  'config.changed': Record<string, never>;
  'catalog.changed': Record<string, never>;
};
export type CacheEvent = keyof CacheEventCtx;

const T = cacheTags;
/** Event → tags (F26 FR-40 table). Frequent events touch only count tags (FR-44): review.answered never drops the map list. */
export const cacheEventTags: { [E in CacheEvent]: (ctx: CacheEventCtx[E]) => CacheTag[] } = {
  'map.changed': ({ userId, mapId }) => [T.user(userId, 'maps'), T.user(userId, 'stats'), T.user(userId, 'review'), ...(mapId ? [T.map(userId, mapId)] : [])],
  'card.changed': ({ userId, mapId }) => [T.user(userId, 'stats'), T.user(userId, 'review'), ...(mapId ? [T.map(userId, mapId)] : [])],
  'review.answered': ({ userId }) => [T.user(userId, 'review'), T.user(userId, 'stats'), T.user(userId, 'progress')],
  'question.changed': ({ userId, mapId }) => [T.user(userId, 'stats'), ...(mapId ? [T.map(userId, mapId)] : [])],
  'summary.changed': ({ userId, mapId }) => [T.user(userId, 'stats'), ...(mapId ? [T.map(userId, mapId)] : [])],
  'challenge.finished': ({ userId }) => [T.user(userId, 'review'), T.user(userId, 'stats'), T.user(userId, 'progress')],
  'calendar.changed': ({ userId }) => [T.user(userId, 'calendar')],
  'notification.changed': ({ userId }) => [T.user(userId, 'notif')],
  'prefs.changed': ({ userId }) => [T.user(userId, 'notif'), T.user(userId, 'profile')],
  'profile.changed': ({ userId }) => [T.user(userId, 'profile')],
  'plan.changed': ({ userId }) => [T.user(userId, 'ent'), T.user(userId, 'maps'), T.user(userId, 'stats')],
  'grant.changed': ({ userId }) => [T.user(userId, 'ent')],
  'referral.changed': ({ userId }) => [T.user(userId, 'referral'), T.user(userId, 'ent')],
  'support.changed': ({ userId }) => [T.user(userId, 'tickets'), 'admin:overview'],
  'account.deleted': ({ userId }) => [T.userAll(userId), 'admin:overview'],
  'admin.action': ({ userId }) => ['admin:overview', ...(userId ? [T.userAll(userId)] : [])],
  'blog.changed': ({ slugs = [], categorySlugs = [] }) => ['blog', 'landing', 'sitemap', 'feed', ...slugs.map(T.blogPost), ...categorySlugs.map(T.blogCategory)],
  'legal.changed': ({ doc }) => [T.legal(doc)],
  'config.changed': () => ['config:plans', 'config:store', 'pricing', 'landing'], // plan definitions and public prices
  'catalog.changed': () => ['catalog:maps'],
};
export const cacheEvents = Object.keys(cacheEventTags) as CacheEvent[];

/** De-duplicated tags of one event. */
export const tagsFor = <E extends CacheEvent>(event: E, ctx: CacheEventCtx[E]): CacheTag[] => [...new Set(cacheEventTags[event](ctx))];

/** F26 "never cache": no cached() for these, whatever the TTL (checked in review; listed in docs/perf/CACHE.md). */
export const neverCache = [
  'card answer / grading (challenge rate, SSE)',
  'session and authentication (liveSession, tokens, D-565)',
  'checkout and payment in progress',
  'support ticket content',
  'audit log',
  'whole map being edited (GET /v1/boards/:id uses ETag instead)',
  'search results',
  'any response with Set-Cookie',
] as const;

/** Body of the API's POST /v1/internal/cache/invalidate (Bearer REVALIDATE_SECRET): one event with its context, or catalog tags (cron, manual SQL). */
export const cacheInvalidateInputSchema = z.union([
  z.object({
    event: z.enum(cacheEvents as [CacheEvent, ...CacheEvent[]]),
    ctx: z
      .object({ userId: z.string().min(1).max(64).optional(), mapId: z.string().min(1).max(64).optional(), slugs: z.array(z.string().min(1).max(200)).max(50).optional(), categorySlugs: z.array(z.string().min(1).max(200)).max(50).optional(), doc: z.enum(legalDocs).optional() })
      .strict()
      .default({}),
  }).strict(),
  z.object({ tags: z.array(z.string().min(1).max(200).refine(isCacheTag, 'not a catalog tag')).min(1).max(100) }).strict(),
]);
export type CacheInvalidateInput = z.infer<typeof cacheInvalidateInputSchema>;
