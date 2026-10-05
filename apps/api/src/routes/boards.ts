import { Hono } from 'hono';
import {
  applyMapOpsInputSchema, boardListQuerySchema, boardTitleSchema, createBoardInputSchema, errorHttpStatus, parseWith, updateBoardInputSchema,
  SHARE_ACCESS_HEADER, copyBoardInputSchema, updateShareInputSchema,
  type HttpErrorBody, type Result,
} from '@remoa/contracts';
import { z } from 'zod';
import type { Env } from '../app';
import { applyMapOps, createBoard, deleteBoard, duplicateBoard, getBoard, listBoards, updateBoard } from '../boards/boards';
import { copySharedBoard } from '../boards/copy';
import { getShare, updateShare } from '../boards/share';

const send = <T>(r: Result<T>, status: 200 | 201 = 200) =>
  r.ok
    ? Response.json({ ok: true, data: r.data }, { status })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const body = (req: Request) => req.json().catch(() => null);
const duplicateInput = z.object({ title: boardTitleSchema });

export const boardsRoutes = new Hono<Env>()
  .get('/', async (c) => {
    const q = parseWith(boardListQuerySchema, c.req.query());
    return send(q.ok ? await listBoards(c.get('userId'), q.data) : q);
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
  .get('/:id', async (c) => send(await getBoard(c.get('userId'), c.req.param('id'))))
  .patch('/:id', async (c) => {
    const input = parseWith(updateBoardInputSchema, await body(c.req.raw));
    return send(input.ok ? await updateBoard(c.get('userId'), c.req.param('id'), input.data) : input);
  })
  .delete('/:id', async (c) => send(await deleteBoard(c.get('userId'), c.req.param('id'))))
  .post('/:id/duplicate', async (c) => {
    const input = parseWith(duplicateInput, await body(c.req.raw));
    return send(input.ok ? await duplicateBoard(c.get('userId'), c.req.param('id'), input.data.title) : input, 201);
  });
