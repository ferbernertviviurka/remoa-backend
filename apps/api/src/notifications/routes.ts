import { Hono } from 'hono';
import {
  errorHttpStatus, markReadInputSchema, notificationListQuerySchema, notificationPrefsPatchSchema, parseWith, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { dismiss, getPrefs, listNotifications, markRead, patchPrefs, unreadCount } from './service';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (req: Request) => req.json().catch(() => null);

/** G18 F26. Mounted at /v1/notifications behind requireUser. `/prefs` and `/unread-count` are registered before `/:id`. */
export const notificationsRoutes = new Hono<Env>()
  .get('/', async (c) => {
    const q = parseWith(notificationListQuerySchema, c.req.query());
    return send(q.ok ? await listNotifications(c.get('userId'), q.data) : q);
  })
  .get('/unread-count', async (c) => send(await unreadCount(c.get('userId'))))
  .post('/read', async (c) => {
    const i = parseWith(markReadInputSchema, await body(c.req.raw));
    return send(i.ok ? await markRead(c.get('userId'), i.data) : i);
  })
  .get('/prefs', async (c) => send(await getPrefs(c.get('userId'))))
  .patch('/prefs', async (c) => {
    const i = parseWith(notificationPrefsPatchSchema, await body(c.req.raw));
    return send(i.ok ? await patchPrefs(c.get('userId'), i.data) : i);
  })
  .delete('/:id', async (c) => send(await dismiss(c.get('userId'), c.req.param('id'))));
