import { Hono } from 'hono';
import { errorHttpStatus, parseWith, uploadCompleteInputSchema, uploadSignInputSchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { takeUploadSlot } from '../uploads/rate-limit';
import { completeUpload, getAsset, signUpload } from '../uploads/uploads';

const send = <T>(r: Result<T>, status: 200 | 201 = 200) =>
  r.ok
    ? Response.json({ ok: true, data: r.data }, { status })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (req: Request) => req.json().catch(() => null);

export const uploadsRoutes = new Hono<Env>()
  .post('/sign', async (c) => {
    const input = parseWith(uploadSignInputSchema, await body(c.req.raw));
    if (!input.ok) return send(input);
    const slot = takeUploadSlot(c.get('userId'));
    return send(slot.ok ? await signUpload(c.get('userId'), input.data) : slot);
  })
  .post('/complete', async (c) => {
    const input = parseWith(uploadCompleteInputSchema, await body(c.req.raw));
    const r = input.ok ? await completeUpload(c.get('userId'), input.data) : input;
    if (!r.ok) c.get('log').warn('upload rejected', { code: r.error.code });
    return send(r, 201);
  });

export const assetsRoutes = new Hono<Env>().get('/:id', async (c) => send(await getAsset(c.get('userId'), c.req.param('id'))));
