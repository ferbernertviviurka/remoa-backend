// G21 T7: every write path invalidates with the right event, and the internal route is mounted. No database.
//   (1) static: each module below calls invalidate('<event>' (the catalog event of its tables); a removed or renamed call fails here.
//   (2) blogChanged: the F27 tags become the blog.changed context.
//   (3) POST /v1/internal/cache/invalidate through the real app: 401 without the secret, 422 on a bad body, 200 on a valid event.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@remoa/config';
import { createApp } from '../app';
import { cacheTags } from '@remoa/contracts';
import { cached, resetCache, type UserCacheDef } from '.';

const SRC = join(import.meta.dirname, '..');
const src = (p: string) => readFileSync(join(SRC, p), 'utf8');

// file -> events it must invalidate (after COMMIT)
const WIRING: Record<string, string[]> = {
  'account/account.ts': ['account.deleted'], 'account/jobs.ts': ['account.deleted'],
  'account/avatar.ts': ['profile.changed'], 'account/email.ts': ['profile.changed'], 'account/identities.ts': ['profile.changed'],
  'account/legal.ts': ['profile.changed', 'legal.changed'], 'account/profile.ts': ['profile.changed', 'calendar.changed'], 'onboarding/onboarding.ts': ['profile.changed'],
  'account/preferences.ts': ['prefs.changed'], 'emails/unsubscribe.ts': ['prefs.changed'], 'notifications/service.ts': ['notification.changed', 'prefs.changed'],
  'notifications/notify.ts': ['notification.changed'], 'inngest/notices.ts': ['notification.changed'],
  'boards/boards.ts': ['map.changed', 'card.changed'], 'boards/copy.ts': ['map.changed'], 'imports/imports.ts': ['map.changed'], 'matrix/matrix.ts': ['map.changed'], 'ai/service.ts': ['map.changed', 'card.changed'],
  'cards/cards.ts': ['card.changed'], 'editorial/editorial.ts': ['card.changed', 'catalog.changed', 'map.changed', 'profile.changed'],
  'review/record-attempt.ts': ['review.answered'], 'review/study.ts': ['card.changed'], 'challenge/session.ts': ['review.answered'],
  'challenge-ai/generate.ts': ['question.changed'], 'challenge-ai/summary.ts': ['summary.changed'], 'challenge-ai/session.ts': ['challenge.finished'],
  'routes/challenge-ai.ts': ['challenge.finished'],
  'calendar/events.ts': ['calendar.changed'], 'calendar/labels.ts': ['calendar.changed'], 'calendar/settings.ts': ['calendar.changed'], 'calendar/reminders/dispatch.ts': ['calendar.changed'],
  'billing/webhook.ts': ['plan.changed'], 'billing/credits.ts': ['referral.changed'],
  'referral/attribution.ts': ['referral.changed'], 'referral/invites.ts': ['referral.changed'], 'referral/qualify.ts': ['referral.changed'], 'referral/sweep.ts': ['referral.changed'],
  'support/tickets.ts': ['support.changed'], 'support/retention.ts': ['support.changed'], 'admin/tickets/routes.ts': ['support.changed'],
  'blog/sitemap.ts': ['blog.changed'], 'inngest/blog.ts': ['blog.changed'], 'blog/revalidate.ts': ['blog.changed'],
  'admin/core/with-admin.ts': ['admin.action'], 'admin/overview/metrics.ts': ['admin.action'], 'admin/maps/routes.ts': ['map.changed', 'catalog.changed'],
  'admin/payments/routes.ts': ['plan.changed'], 'admin/referrals/routes.ts': ['referral.changed', 'grant.changed'], 'admin/users/routes.ts': ['grant.changed'],
};

describe('invalidate wiring (G21 T7)', () => {
  it.each(Object.entries(WIRING))('%s calls invalidate with %j', (file, events) => {
    const code = src(file);
    for (const e of events) expect(code, `${file} must call invalidate('${e}', ...)`).toMatch(new RegExp(`invalidate\\(\\s*'${e.replace('.', '\\.')}'`));
  });

  it('the retired global wipe is gone: app.ts no longer drops the hub on every write', () => {
    expect(src('app.ts')).not.toMatch(/invalidateReviewHub/);
    expect(src('review/hub.ts')).not.toMatch(/const cache = new Map|invalidateReviewHub/);
    expect(src('review/queue.ts')).not.toMatch(/const cache = new Map/);
  });

  it('review caches live in cached(): a review.answered drops them (tags of the hub and of retrievability)', async () => {
    const { invalidate } = await import('.');
    resetCache();
    const def: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'review-hub', ttl: 'live', tags: ({ userId }) => [cacheTags.user(userId, 'review')] };
    let n = 0;
    const read = () => cached(def, { userId: 'u1' }, async () => ++n);
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    await invalidate('review.answered', { userId: 'u1' });
    expect(await read()).toBe(2);
    await invalidate('review.answered', { userId: 'u2' }); // another user's write never drops u1
    expect(await read()).toBe(2);
  });
});

describe('blogChanged', () => {
  it('turns the F27 post/category tags into the blog.changed context', async () => {
    vi.resetModules();
    const invalidate = vi.fn(async () => ({ tags: [], dropped: 0 }));
    vi.doMock('../cache', () => ({ invalidate }));
    const { blogChanged } = await import('../blog/revalidate');
    await blogChanged(['blog', 'landing', 'blog:post:meu-post', 'blog:category:clinica', 'blog:post:outro']);
    expect(invalidate).toHaveBeenCalledWith('blog.changed', { slugs: ['meu-post', 'outro'], categorySlugs: ['clinica'] }, undefined);
    vi.doUnmock('../cache');
  });
});

describe('POST /v1/internal/cache/invalidate (mounted by app.ts)', () => {
  const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async () => null });
  const auth = { authorization: `Bearer ${env().revalidateSecret}`, 'content-type': 'application/json' };
  const post = (body: unknown, headers: Record<string, string> = auth) => app.request('/v1/internal/cache/invalidate', { method: 'POST', headers, body: JSON.stringify(body) });
  afterEach(() => resetCache());

  it('401 without the secret, with a wrong one, and on stats', async () => {
    expect((await post({ event: 'map.changed', ctx: { userId: 'u1' } }, { 'content-type': 'application/json' })).status).toBe(401);
    expect((await post({ event: 'map.changed', ctx: { userId: 'u1' } }, { authorization: 'Bearer nope', 'content-type': 'application/json' })).status).toBe(401);
    expect((await app.request('/v1/internal/cache/stats')).status).toBe(401);
  });

  it('422 on an unknown event, an unknown tag or a context that yields no tags', async () => {
    expect((await post({ event: 'nope', ctx: {} })).status).toBe(422);
    expect((await post({ tags: ['not:a:tag'] })).status).toBe(422);
    expect((await post({ event: 'map.changed', ctx: {} })).status).toBe(422); // user event without a userId
  });

  it('200 drops the entries of the event and reports the tags', async () => {
    const def: UserCacheDef<{ userId: string }> = { scope: 'user', name: 'maps', ttl: 'short', tags: ({ userId }) => [cacheTags.user(userId, 'maps')] };
    let n = 0;
    const read = () => cached(def, { userId: 'u1' }, async () => ++n);
    await read();
    const res = await post({ event: 'map.changed', ctx: { userId: 'u1' } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.tags).toContain('user:u1:maps');
    expect(await read()).toBe(2);
    const stats = await app.request('/v1/internal/cache/stats', { headers: auth });
    expect(stats.status).toBe(200);
  });
});
