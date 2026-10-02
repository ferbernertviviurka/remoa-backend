import { Hono } from 'hono';
import { errorHttpStatus, parseWith, unsubscribeQuerySchema } from '@remoa/contracts';
import { unsubscribeButton, unsubscribeConfirm, unsubscribedPage } from '../account/email-copy';
import { isValidUnsubscribeToken, unsubscribeReminder } from '../account/reminders';

const page = (inner: string) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remoa</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">${inner}</body></html>`;

/**
 * No auth: the signed token in the e-mail is the credential. Unaffected by requireUser and D-123.
 * GET only renders a confirm button (link scanners prefetch GETs); POST to the same URL changes state (RFC 8058 one-click).
 */
export const publicRoutes = () => {
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
    });
};
