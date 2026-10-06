// G18 F24 HTTP: /v1/emails/{webhook,unsubscribe} (public, signed), /v1/auth/send-email (Supabase hook, signed) and /v1/dev/emails (never in production).
import { Hono, type Context } from 'hono';
import { env, isProduction } from '@remoa/config';
import { EMAIL_CLASS, emailTemplateSchema } from '@remoa/contracts';
import { emailSamples, emails, render, sampleData, sampleLinks } from '@remoa/emails';
import { fail, type Env } from '../app';
import { clientIp } from '../client-ip';
import { handleSendEmailHook, sendEmailHookSchema } from './auth-hook';
import { footerLegal } from './send';
import { verifySigned } from './signature';
import { verifyUnsubscribeToken, type UnsubscribeClaim } from './tokens';
import { applyUnsubscribe, canUnsubscribe } from './unsubscribe';
import { handleResendEvent } from './webhook';

// ---------------------------------------------------------------- rate limit (public routes)
// ponytail: in-memory fixed window per process, like the other public routes; one-click POSTs come from a few mail-provider IPs, hence the high cap.
const hits = new Map<string, { n: number; reset: number }>();
const UNSUB_PER_MINUTE = 300;
const slot = (ip: string, now = Date.now()) => {
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return true;
  }
  return ++h.n <= UNSUB_PER_MINUTE;
};

// ---------------------------------------------------------------- unsubscribe page (no personal data: only the kind of notice)
const u = emails.unsubscribe;
const fill = (s: string, what: string) => s.replace('{what}', what);
const page = (inner: string) =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${u.pageTitle}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1A1533;background:#F6F5FB;line-height:1.5">` +
  `<p style="font-weight:800;font-size:1.75rem;color:#6D5BD0;margin:0 0 1.5rem">${emails.brand}</p>${inner}</body></html>`;
const manageLink = () => `<p><a href="${env().appUrl}/app/notificacoes" style="color:#3F3579">${u.manage}</a></p>`;
const htmlHeaders = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' };
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...htmlHeaders } });

const claimOf = (c: Context): UnsubscribeClaim | null => {
  const token = c.req.query('token');
  if (!token || token.length > 512) return null;
  const claim = verifyUnsubscribeToken(token);
  return claim && canUnsubscribe(claim) ? claim : null;
};

/** GET: only a confirm button (link scanners prefetch GETs, so a GET never changes state). */
export const unsubscribePage = (c: Context) => {
  if (!slot(clientIp(c))) return fail({ code: 'rate_limited', message: 'too many requests' });
  const claim = claimOf(c);
  if (!claim) return html(page(`<p>${u.invalid}</p>${manageLink()}`), 422);
  const token = encodeURIComponent(c.req.query('token')!);
  return html(page(
    `<form method="post" action="?token=${token}"><input type="hidden" name="List-Unsubscribe" value="One-Click">` +
    `<p>${fill(u.confirm, u.what[claim.scope])}</p>` +
    `<button type="submit" style="min-height:44px;padding:0 1.25rem;font-size:1rem;border:0;border-radius:12px;background:#6D5BD0;color:#fff;cursor:pointer">${u.button}</button></form>`,
  ));
};

/** POST: the page's button and RFC 8058 one-click (`List-Unsubscribe=One-Click` form body, token in the query). */
export const unsubscribeApply = async (c: Context) => {
  if (!slot(clientIp(c))) return fail({ code: 'rate_limited', message: 'too many requests' });
  const claim = claimOf(c);
  if (!claim) return html(page(`<p>${u.invalid}</p>${manageLink()}`), 422);
  await applyUnsubscribe(claim);
  return html(page(`<p>${fill(u.done, u.what[claim.scope])}</p><p>${u.doneHint}</p>${manageLink()}`));
};

// ---------------------------------------------------------------- /v1/emails
export const emailsRoutes = new Hono<Env>()
  .post('/webhook', async (c) => {
    const body = await c.req.text();
    const event = verifySigned(env().resendWebhookSecret, { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') }, body);
    if (!event) return fail({ code: 'unauthorized', message: 'invalid signature' });
    const outcome = await handleResendEvent(event);
    return c.json({ ok: true, data: { outcome } });
  })
  .get('/unsubscribe', unsubscribePage)
  .post('/unsubscribe', unsubscribeApply);

// ---------------------------------------------------------------- /v1/auth/send-email (Supabase Auth hook, Standard Webhooks)
/** Supabase reads `{ error: { http_code, message } }`; 200 with `{}` = handled. */
const hookError = (http_code: 400 | 401 | 500, message: string) => Response.json({ error: { http_code, message } }, { status: http_code });

export const authHookRoutes = new Hono<Env>().post('/send-email', async (c) => {
  const body = await c.req.text();
  const id = c.req.header('webhook-id');
  const payload = verifySigned(env().sendEmailHookSecret, { id, timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') }, body);
  if (!payload || !id) return hookError(401, 'invalid signature');
  const p = sendEmailHookSchema.safeParse(payload);
  if (!p.success) return hookError(400, 'invalid payload');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return hookError(500, 'auth url not configured');
  const r = await handleSendEmailHook(p.data, id, supabaseUrl);
  c.get('log').info('auth email hook', { action: p.data.email_data.email_action_type, status: r.status, note: r.status === 'ok' ? r.note : undefined });
  return r.status === 'ok' ? c.json({}) : hookError(500, r.message);
});

// ---------------------------------------------------------------- /v1/dev/emails (FR-19; 404 in production)
const versionsOf = () => {
  const out = new Map<string, string[]>();
  for (const { template, version } of emailSamples) out.set(template, [...(out.get(template) ?? []), version]);
  return [...out].map(([template, versions]) => ({ template, versions }));
};

export const devEmailsRoutes = new Hono<Env>()
  .use('*', async (c, next) => (isProduction() ? fail({ code: 'not_found', message: 'route not found' }) : next()))
  .get('/', (c) => c.json({ ok: true, data: versionsOf() }))
  .get('/:template/:version', async (c) => {
    const t = emailTemplateSchema.safeParse(c.req.param('template'));
    const version = c.req.param('version');
    if (!t.success || !emailSamples.some((s) => s.template === t.data && s.version === version)) return fail({ code: 'not_found', message: 'unknown template' });
    const r = await render(t.data, sampleData(t.data, version), { ...sampleLinks(t.data), ...footerLegal() });
    return c.json({ ok: true, data: { ...r, class: EMAIL_CLASS[t.data], bytes: Buffer.byteLength(r.html) } });
  });
