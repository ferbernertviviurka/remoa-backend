import { Hono } from 'hono';
import { compress } from 'hono/compress';
import {
  applyMapOpsInputSchema, boardTitleSchema, createBoardInputSchema, errorHttpStatus, parseWith, updateBoardInputSchema,
  SHARE_ACCESS_HEADER, copyBoardInputSchema, updateShareInputSchema,
  type HttpErrorBody, type Result,
} from '@remoa/contracts';
import { z } from 'zod';
import type { Env } from '../app';
import { applyMapOps, boardListPageSchema, boardViewQuerySchema, createBoard, deleteBoard, duplicateBoard, getBoardView, listBoardsPage, updateBoard } from '../boards/boards';
import { copySharedBoard } from '../boards/copy';
import { getShare, updateShare } from '../boards/share';

const send = <T>(r: Result<T>, status: 200 | 201 = 200, headers?: Record<string, string>) =>
  r.ok
    ? Response.json({ ok: true, data: r.data }, { status, headers })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const body = (req: Request) => req.json().catch(() => null);
const duplicateInput = z.object({ title: boardTitleSchema });

export const boardsRoutes = new Hono<Env>()
  // G21 FR-20 (D-1034): the list and the map are the two big JSON bodies; gzip/br only here (the host may also compress, never twice: Content-Encoding is checked)
  .use('*', (c, next) => (c.req.method === 'GET' ? compress()(c, next) : next()))
  .get('/', async (c) => {
    const q = parseWith(boardListPageSchema, c.req.query());
    if (!q.ok) return send(q);
    const r = await listBoardsPage(c.get('userId'), q.data);
    // body stays the plain array (contract); the cursor travels in a header
    return send(r.ok ? { ok: true as const, data: r.data.items } : r, 200, r.ok && r.data.nextCursor ? { 'X-Next-Cursor': r.data.nextCursor } : undefined);
  })
  .post('/', async (c) => {
    const input = parseWith(createBoardInputSchema, await body(c.req.raw));
    return send(input.ok ? await createBoard(c.get('userId'), input.data) : input, 201);
  })
  .post('/ops', async (c) => {
    const input = parseWith(applyMapOpsInputSchema, await body(c.req.raw));
    if (!input.ok) return send(input);
    const r = await applyMapOps(c.get('userId'), input.data.ops);
    if (!r.ok) c.get('log').warn('map ops rejected', { code: r.error.code });
    return send(r);
  })
  // F17 T4: copy from a shared link (private boards need the access grant the web app keeps in the cookie)
  .post('/copy', async (c) => {
    const input = parseWith(copyBoardInputSchema, await body(c.req.raw));
    if (!input.ok) return send(input);
    const r = await copySharedBoard(c.get('userId'), input.data, { grant: c.req.header(SHARE_ACCESS_HEADER) ?? null });
    if (!r.ok) c.get('log').warn('board copy rejected', { code: r.error.code });
    return send(r, 201);
  })
  // F17 T3: owner-only share state
  .get('/:id/share', async (c) => send(await getShare(c.get('userId'), c.req.param('id'))))
  .put('/:id/share', async (c) => {
    const input = parseWith(updateShareInputSchema, await body(c.req.raw));
    return send(input.ok ? await updateShare(c.get('userId'), c.req.param('id'), input.data) : input);
  })
  .get('/:id', async (c) => {
    const q = parseWith(boardViewQuerySchema, c.req.query());
    if (!q.ok) return send(q);
    const r = await getBoardView(c.get('userId'), c.req.param('id'), { view: q.data.view, ifNoneMatch: c.req.header('If-None-Match') });
    if (!r.ok) return send(r);
    // no-cache = always revalidate: the ETag turns an unchanged map into a 304 with no body
    const h = { ETag: r.data.etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization, Accept-Encoding' };
    return r.data.notModified ? new Response(null, { status: 304, headers: h }) : send({ ok: true, data: r.data.data }, 200, h);
  })
  .patch('/:id', async (c) => {
    const input = parseWith(updateBoardInputSchema, await body(c.req.raw));
    return send(input.ok ? await updateBoard(c.get('userId'), c.req.param('id'), input.data) : input);
  })
  .delete('/:id', async (c) => send(await deleteBoard(c.get('userId'), c.req.param('id'))))
  .post('/:id/duplicate', async (c) => {
    const input = parseWith(duplicateInput, await body(c.req.raw));
    return send(input.ok ? await duplicateBoard(c.get('userId'), c.req.param('id'), input.data.title) : input, 201);
  });
