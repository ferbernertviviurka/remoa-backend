import { Hono } from 'hono';
import {
  attributionInputSchema, errorHttpStatus, inviteInputSchema, normalizeReferralCode, parseWith, REFERRAL_LIMITS, referralErrors,
  type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { attributeReferral, lookupReferralCode } from '../referral/attribution';
import { sendInvites } from '../referral/invites';
import { getReferralSummary } from '../referral/summary';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();

// requireUser is applied in app.ts. T3: summary, invites. T2: attribution.
export const referralRoutes = new Hono<Env>()
  .get('/summary', async (c) => send(await getReferralSummary(c.get('userId'))))
  .post('/invites', async (c) => {
    const body = parseWith(inviteInputSchema, await c.req.json().catch(() => null));
    return send(body.ok ? await sendInvites(c.get('userId'), body.data.emails, c.get('log')) : body);
  })
  // D-383: called once by the web after the first session; refusals are `{ attributed: false }` with 200
  .post('/attribution', async (c) => {
    const body = parseWith(attributionInputSchema, await c.req.json().catch(() => null));
    if (!body.ok) return send(body);
    return c.json({ ok: true, data: await attributeReferral(c.get('userId'), body.data.code, { log: c.get('log'), ip: clientIp(c), ua: c.req.header('user-agent') ?? '' }) });
  });

// --- public: GET /v1/public/referral/:code (no auth; the code never reaches the logs, app.ts) --------------------------
const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' };
const hits = new Map<string, number[]>();
/** ponytail: in-memory per-IP window, one API instance (Q-008), same as waitlist/shared. */
export function takeLookupSlot(ip: string, now = Date.now()) {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= 60_000)) hits.delete(k);
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  const allowed = list.length < REFERRAL_LIMITS.publicLookupsPerMinute;
  if (allowed) list.push(now);
  hits.set(ip, list);
  return allowed;
}

export const publicReferralRoutes = new Hono<Env>().get('/:code', async (c) => {
  if (!takeLookupSlot(clientIp(c))) return Response.json({ error: { code: 'rate_limited', message: referralErrors.lookupLimit } } satisfies HttpErrorBody, { status: 429, headers });
  const code = normalizeReferralCode(c.req.param('code'));
  return Response.json({ ok: true, data: code ? await lookupReferralCode(code) : { valid: false } }, { headers });
});
