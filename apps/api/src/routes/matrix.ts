import { Hono } from 'hono';
import { errorHttpStatus, matrixAreaSchema, parseWith, type HttpErrorBody, type Result } from '@remoa/contracts';
import { z } from 'zod';
import type { Env } from '../app';
import { listMatrixItems } from '../matrix/matrix';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const matrixRoutes = new Hono<Env>().get('/items', async (c) => {
  const q = parseWith(z.object({ area: matrixAreaSchema }), c.req.query());
  return send(q.ok ? await listMatrixItems(q.data.area) : q);
});
