import { Hono } from 'hono';
import { errorHttpStatus, parseWith, unsubscribeQuerySchema } from '@remoa/contracts';
import { unsubscribeButton, unsubscribeConfirm, unsubscribedPage } from '../account/email-copy';
import { getPublicPriceBook } from '../public/pricebook';
import { joinWaitlist, takeWaitlistSlot } from '../public/waitlist';
import { waitlistRateLimited } from '../public/waitlist-copy';
import type { StripePort } from '../billing/stripe';
import { isValidUnsubscribeToken, unsubscribeReminder } from '../account/reminders';
import { SHARE_ACCESS_HEADER, unlockInputSchema, type AppError, type HttpErrorBody } from '@remoa/contracts';
import { SHARED_ASSET_TTL_SECONDS, getSharedBoard, sharedAssetBytes, takeViewSlot, unlockShared } from '../public/shared';

const page = (inner: string) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remoa</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">${inner}</body></html>`;

/**
 * No auth: the signed token in the e-mail is the credential. Unaffected by requireUser and D-123.
 * GET only renders a confirm button (link scanners prefetch GETs); POST to the same URL changes state (RFC 8058 one-click).
 */
export const publicRoutes = ({ stripe, viewer }: { stripe?: StripePort; viewer?: Viewer } = {}) => {
  const token = (c: { req: { query: (k: string) => string | undefined } }) => parseWith(unsubscribeQuerySchema, { token: c.req.query('token') });
  return new Hono()
    .get('/unsubscribe', (c) => {
      const q = token(c);
      if (!q.ok || !isValidUnsubscribeToken(q.data.token)) return Response.json({ error: { code: 'validation', message: 'invalid token' } }, { status: 422 });
      return c.html(page(`<form method="post" action="?token=${encodeURIComponent(q.data.token)}"><p>${unsubscribeConfirm}</p><button type="submit" style="min-height:44px;padding:0 1rem;font-size:1rem">${unsubscribeButton}</button></form>`));
    })
    .post('/unsubscribe', async (c) => {
      const q = token(c);
      const r = q.ok ? await unsubscribeReminder(q.data.token) : q;
      if (!r.ok) return Response.json({ error: r.error }, { status: errorHttpStatus[r.error.code] });
      return c.html(page(`<p>${unsubscribedPage}</p>`));
    })
    // F16 FR-14: landing waitlist (rate limited by IP, honeypot `website`, duplicate looks like success)
    .post('/waitlist', async (c) => {
      const ip = (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();
      if (!takeWaitlistSlot(ip)) return Response.json({ error: { code: 'rate_limited', message: waitlistRateLimited } }, { status: 429 });
      const r = await joinWaitlist(await c.req.json().catch(() => null), c.req.header('x-request-id') ?? 'public');
      return r.ok ? c.json({ ok: true, data: null }) : Response.json({ error: r.error }, { status: errorHttpStatus[r.error.code] });
    })
    // F16 FR-12: prices for the landing (`?v=29|49` = price-test variant, D-233)
    .get('/pricebook', async (c) => {
      const v = c.req.query('v');
      if (v !== undefined && v !== '29' && v !== '49') return Response.json({ error: { code: 'validation', message: 'invalid variant' } }, { status: 422 });
      const r = await getPublicPriceBook(stripe)(v);
      return r.ok ? c.json({ ok: true, data: r.data }) : Response.json({ error: r.error }, { status: errorHttpStatus[r.error.code] });
    })
    .route('/shared', sharedRoutes(viewer));
};

/** Optional session on a public route: the user id, or null when absent or invalid (never an error). */
export type Viewer = (authorization: string | undefined) => Promise<string | null>;

// F17 T3: the `/m/<token>` page. Nothing here may be cached by a proxy or indexed; the token never reaches the logs (app.ts).
const sharedHeaders = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' };
const sharedJson = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...sharedHeaders, ...extra } });
const sharedFail = (r: { error: AppError }) => sharedJson({ error: r.error } satisfies HttpErrorBody, errorHttpStatus[r.error.code]);
const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();

export const sharedRoutes = (viewer: Viewer = async () => null) =>
  new Hono()
    .get('/:token', async (c) => {
      if (!takeViewSlot(clientIp(c))) return sharedFail({ error: { code: 'rate_limited', message: 'too many requests' } });
      const r = await getSharedBoard(c.req.param('token'), { grant: c.req.header(SHARE_ACCESS_HEADER) ?? null, viewerId: await viewer(c.req.header('authorization')) });
      return r.ok ? sharedJson({ ok: true, data: r.data }) : sharedFail(r);
    })
    .post('/:token/unlock', async (c) => {
      const input = parseWith(unlockInputSchema, await c.req.json().catch(() => null));
      if (!input.ok) return sharedFail({ error: { code: 'validation', message: 'invalid body' } }); // never echo the field
      const r = await unlockShared(c.req.param('token'), input.data, { ip: clientIp(c) });
      return r.ok ? sharedJson({ ok: true, data: r.data }) : sharedFail(r);
    })
    .get('/:token/assets/:assetId/:variant', async (c) => {
      const r = await sharedAssetBytes(c.req.param('token'), c.req.param('assetId'), c.req.param('variant'), c.req.query('e'), c.req.query('s'));
      if (!r.ok) return sharedFail(r);
      return new Response(new Uint8Array(r.data), {
        headers: { 'content-type': 'image/webp', 'cache-control': `private, max-age=${SHARED_ASSET_TTL_SECONDS}`, 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' },
      });
    });
