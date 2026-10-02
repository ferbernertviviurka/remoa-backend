import { Hono } from 'hono';
import { errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { getHomeSummary } from '../home/home';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const homeRoutes = new Hono<Env>().get('/', async (c) => send(await getHomeSummary(c.get('userId'), new Date())));
