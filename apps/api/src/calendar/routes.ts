import { Hono } from 'hono';
import {
  calendarEventInputSchema, calendarEventPatchSchema, calendarLabelInputSchema, calendarLabelPatchSchema, calendarRangeQuerySchema, calendarViewInputSchema,
  duplicateEventInputSchema, errorHttpStatus, eventRemindersInputSchema, parseWith, upcomingQuerySchema, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { clientIp } from '../client-ip';
import { createEvent, deleteEvent, duplicateEvent, listEvents, setEventReminders, updateEvent, upcoming } from './events';
import { coverRedirectOf, eventOfCoverToken, eventOfIcsToken, icsOf } from './ics';
import { createLabel, deleteLabel, listLabels, updateLabel } from './labels';
import { getSettings, markTourSeen, setView } from './settings';

const send = <T>(r: Result<T>, status: 200 | 201 = 200) =>
  r.ok ? Response.json({ ok: true, data: r.data }, { status }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (req: Request) => req.json().catch(() => null);
const icsResponse = (r: Result<{ filename: string; body: string }>, extra: Record<string, string> = {}) =>
  r.ok
    ? new Response(r.data.body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${r.data.filename}"`, ...extra } })
    : send(r);

/** G18 F25. Mounted at /v1/calendar behind requireUser. Every write replans the event's reminders (inside the same transaction). */
export const calendarRoutes = new Hono<Env>()
  .get('/events', async (c) => {
    const q = parseWith(calendarRangeQuerySchema, c.req.query());
    return send(q.ok ? await listEvents(c.get('userId'), q.data) : q);
  })
  .post('/events', async (c) => {
    const i = parseWith(calendarEventInputSchema, await body(c.req.raw));
    return send(i.ok ? await createEvent(c.get('userId'), i.data) : i, 201);
  })
  .get('/events/:file{.+\\.ics}', async (c) => icsResponse(await icsOf(c.req.param('file').slice(0, -4), c.get('userId')), { 'cache-control': 'private, no-store' }))
  .patch('/events/:id', async (c) => {
    const i = parseWith(calendarEventPatchSchema, await body(c.req.raw));
    return send(i.ok ? await updateEvent(c.get('userId'), c.req.param('id'), i.data) : i);
  })
  .delete('/events/:id', async (c) => send(await deleteEvent(c.get('userId'), c.req.param('id'))))
  .post('/events/:id/duplicate', async (c) => {
    const i = parseWith(duplicateEventInputSchema, (await body(c.req.raw)) ?? {});
    return send(i.ok ? await duplicateEvent(c.get('userId'), c.req.param('id'), i.data) : i, 201);
  })
  .patch('/events/:id/reminders', async (c) => {
    const i = parseWith(eventRemindersInputSchema, await body(c.req.raw));
    return send(i.ok ? await setEventReminders(c.get('userId'), c.req.param('id'), i.data) : i);
  })
  .get('/upcoming', async (c) => {
    const q = parseWith(upcomingQuerySchema, c.req.query());
    return send(q.ok ? await upcoming(c.get('userId'), q.data.limit, new Date()) : q);
  })
  .get('/labels', async (c) => send(await listLabels(c.get('userId'))))
  .post('/labels', async (c) => {
    const i = parseWith(calendarLabelInputSchema, await body(c.req.raw));
    return send(i.ok ? await createLabel(c.get('userId'), i.data) : i, 201);
  })
  .patch('/labels/:id', async (c) => {
    const i = parseWith(calendarLabelPatchSchema, await body(c.req.raw));
    return send(i.ok ? await updateLabel(c.get('userId'), c.req.param('id'), i.data) : i);
  })
  .delete('/labels/:id', async (c) => send(await deleteLabel(c.get('userId'), c.req.param('id'))))
  .get('/settings', async (c) => send(await getSettings(c.get('userId'))))
  .post('/tour-seen', async (c) => send(await markTourSeen(c.get('userId'))))
  .patch('/view', async (c) => {
    const i = parseWith(calendarViewInputSchema, await body(c.req.raw));
    return send(i.ok ? await setView(c.get('userId'), i.data.view) : i);
  });

// Fixed-window limit per IP: the token is the credential, this only keeps a scanner from hammering the DB.
const hits = new Map<string, { n: number; reset: number }>();
const slot = (ip: string, now = Date.now()) => {
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); return true; }
  return ++h.n <= 60;
};

/** GET /v1/public/calendar/:token.ics: no auth, HMAC token over the event id (the e-mail's "Adicionar ao calendário"). */
export const publicCalendarRoutes = new Hono()
  // P-322: the e-mail's cover. No auth (HMAC `cover:` token); 302 to a 1-hour signed URL of the 800 px WebP, never cached by proxies.
  .get('/cover/:token', async (c) => {
    if (!slot(clientIp(c))) return send({ ok: false, error: { code: 'rate_limited', message: 'too many requests' } });
    const id = eventOfCoverToken(c.req.param('token'));
    const to = id ? await coverRedirectOf(id) : null;
    if (!to) return send({ ok: false, error: { code: 'not_found', message: 'cover not found' } });
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' } });
  })
  .get('/:file{.+\\.ics}', async (c) => {
    if (!slot(clientIp(c))) return send({ ok: false, error: { code: 'rate_limited', message: 'too many requests' } });
    const id = eventOfIcsToken(c.req.param('file').slice(0, -4));
    return icsResponse(id ? await icsOf(id, null) : { ok: false, error: { code: 'not_found', message: 'event not found' } }, { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' });
  });
