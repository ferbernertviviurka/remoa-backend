import { Hono } from 'hono';
import { errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { getStoreConfig, getStoreWaitlist, leaveStoreWaitlist, putStoreWaitlist } from '../store/waitlist';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

/** G16 (CCR-030). Mounted at /v1/store behind requireUser. */
export const storeRoutes = new Hono<Env>()
  .get('/config', () => send({ ok: true, data: getStoreConfig() }))
  .get('/waitlist', async (c) => send(await getStoreWaitlist(c.get('userId'))))
  .put('/waitlist', async (c) => send(await putStoreWaitlist(c.get('userId'), await c.req.json().catch(() => null), c.get('requestId'))))
  .delete('/waitlist', async (c) => send(await leaveStoreWaitlist(c.get('userId'))));
