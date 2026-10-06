import { Hono } from 'hono';
import { errorHttpStatus, existingBoardQuerySchema, importKeySchema, importUploadSignInputSchema, parseWith, startImportInputSchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import type { Imports } from '../imports/imports';
import { takeUploadSlot } from '../uploads/rate-limit';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (req: Request) => req.json().catch(() => null);

export const importsRoutes = (imp: Imports) =>
  new Hono<Env>()
    .post('/anki/sign', async (c) => {
      const i = parseWith(importUploadSignInputSchema, await body(c.req.raw));
      return send(i.ok ? await imp.sign(c.get('userId'), i.data) : i);
    })
    // D-1443: raw body (application/octet-stream), streamed to the bucket; the browser never talks to the storage. `/anki/sign` stays for old clients (P-626).
    .post('/anki/direct', async (c) => {
      const slot = takeUploadSlot(c.get('userId'));
      if (!slot.ok) return send(slot);
      const length = c.req.header('content-length');
      const r = await imp.upload(c.get('userId'), c.req.raw.body, length ? Number(length) : null);
      if (r.ok) return send(r);
      c.get('log').warn('anki upload rejected', { code: r.error.code, message: r.error.message });
      return r.error.message === 'file_too_large' ? Response.json({ error: r.error } satisfies HttpErrorBody, { status: 413 }) : send(r);
    })
    .post('/anki/inspect', async (c) => {
      const i = parseWith(importKeySchema, await body(c.req.raw));
      return send(i.ok ? await imp.inspectImport(c.get('userId'), i.data) : i);
    })
    .post('/anki', async (c) => {
      const i = parseWith(startImportInputSchema, await body(c.req.raw));
      return send(i.ok ? await imp.start(c.get('userId'), i.data) : i);
    })
    /** F17 FR-11: check if an own active board with the same normalised title already exists. */
    .get('/anki/existing', async (c) => {
      const q = parseWith(existingBoardQuerySchema, { title: c.req.query('title') });
      return send(q.ok ? await imp.findExistingBoard(c.get('userId'), q.data.title) : q);
    })
    .get('/:id/report', async (c) => send(await imp.report(c.get('userId'), c.req.param('id'))))
    .get('/:id', async (c) => send(await imp.progress(c.get('userId'), c.req.param('id'))));
