import { Hono } from 'hono';
import { boardMatrixLinkSchema, errorHttpStatus, matrixAreaSchema, parseWith, type HttpErrorBody, type Result } from '@remoa/contracts';
import { z } from 'zod';
import type { Env } from '../app';
import { linkBoardMatrix, listMatrixItems, suggestMatrixItems, unlinkBoardMatrix } from '../matrix/matrix';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const body = (req: Request) => req.json().catch(() => null);

export const matrixRoutes = new Hono<Env>()
  .get('/items', async (c) => {
    const q = parseWith(z.object({ area: matrixAreaSchema }), c.req.query());
    return send(q.ok ? await listMatrixItems(q.data.area) : q);
  })
  .get('/suggest', async (c) => {
    const q = parseWith(z.object({ title: z.string().trim().min(1).max(200) }), c.req.query());
    return send(q.ok ? await suggestMatrixItems(q.data.title) : q);
  })
  .post('/links', async (c) => {
    const i = parseWith(boardMatrixLinkSchema, await body(c.req.raw));
    return send(i.ok ? await linkBoardMatrix(c.get('userId'), i.data) : i);
  })
  .delete('/links', async (c) => {
    const i = parseWith(boardMatrixLinkSchema, await body(c.req.raw));
    return send(i.ok ? await unlinkBoardMatrix(c.get('userId'), i.data) : i);
  });
