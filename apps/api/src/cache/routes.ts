// G21/F29 T6 (D-980, FR-43): POST /v1/internal/cache/invalidate for writers outside the API process (Railway cron, manual SQL).
// `Authorization: Bearer ${REVALIDATE_SECRET}`; body `{ event, ctx }` or `{ tags }` (catalog tags only). Web tags are forwarded to the web.
// GET /v1/internal/cache/stats: hit rate per cache since boot (FR-39). Mounted in app.ts by T7: app.route('/v1/internal/cache', internalCacheRoutes).
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '@remoa/config';
import { cacheInvalidateInputSchema, type CacheEvent, type CacheEventCtx } from '@remoa/contracts';
import { fail, type Env } from '../app';
import { cacheStats, invalidate, invalidateTags } from '.';

// Digests first: equal length, so the comparison is constant-time whatever the header holds.
const digest = (s: string) => createHash('sha256').update(s).digest();
const authorized = (header: string | undefined) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${env().revalidateSecret}`));

export const internalCacheRoutes = new Hono<Env>()
  .use(async (c, next) => (authorized(c.req.header('authorization')) ? next() : fail({ code: 'unauthorized', message: 'invalid revalidate secret' })))
  .post('/invalidate', async (c) => {
    const body = cacheInvalidateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail({ code: 'validation', message: 'invalid body' });
    const log = c.get('log');
    const r = 'tags' in body.data ? await invalidateTags(body.data.tags, log) : await invalidate(body.data.event as CacheEvent, body.data.ctx as CacheEventCtx[CacheEvent], log);
    if (!r.tags.length) return fail({ code: 'validation', message: 'event context does not produce catalog tags' });
    log.info('cache invalidated (internal)', { source: 'event' in body.data ? body.data.event : 'tags', tags: r.tags.length, dropped: r.dropped });
    return c.json({ ok: true, data: r });
  })
  .get('/stats', (c) => c.json({ ok: true, data: cacheStats() }));
