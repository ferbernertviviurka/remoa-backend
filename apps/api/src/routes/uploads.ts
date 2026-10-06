import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  IMAGE_MAX_BYTES, errorHttpStatus, parseWith, uploadCompleteInputSchema, uploadSignInputSchema, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { takeUploadSlot } from '../uploads/rate-limit';
import { completeUpload, getAsset, processImage, signUpload } from '../uploads/uploads';

const send = <T>(r: Result<T>, status: 200 | 201 = 200) =>
  r.ok
    ? Response.json({ ok: true, data: r.data }, { status })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (req: Request) => req.json().catch(() => null);

/** D-1202: multipart image upload capped at 100 MB (+ room for the form fields) before anything is buffered; 413 above. */
export const imageBodyLimit = bodyLimit({
  maxSize: IMAGE_MAX_BYTES + 64 * 1024,
  onError: () => Response.json({ error: { code: 'validation', message: 'file_too_large' } } satisfies HttpErrorBody, { status: 413 }),
});

const directFields = uploadCompleteInputSchema.omit({ key: true });

/** The `file` field of a multipart body as bytes, plus the other text fields. */
export async function readImageForm(req: Request): Promise<Result<{ bytes: Buffer; fields: Record<string, string> }>> {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!form || !(file instanceof File) || file.size === 0) return { ok: false, error: { code: 'validation', message: 'file is required' } };
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, error: { code: 'validation', message: 'file_too_large' } };
  const fields: Record<string, string> = {};
  form.forEach((v, k) => typeof v === 'string' && (fields[k] = v));
  return { ok: true, data: { bytes: Buffer.from(await file.arrayBuffer()), fields } };
}

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
  })
  // D-1202: server-side upload (same path as the blog): no browser PUT to the bucket, so no bucket CORS needed.
  .post('/direct', imageBodyLimit, async (c) => {
    const slot = takeUploadSlot(c.get('userId'));
    if (!slot.ok) return send(slot);
    const form = await readImageForm(c.req.raw);
    if (!form.ok) return send(form);
    const meta = parseWith(directFields, { license: form.data.fields.license, attribution: form.data.fields.attribution || null });
    const r = meta.ok ? await processImage(c.get('userId'), form.data.bytes, meta.data) : meta;
    if (!r.ok) c.get('log').warn('upload rejected', { code: r.error.code });
    return send(r, 201);
  });

export const assetsRoutes = new Hono<Env>().get('/:id', async (c) => send(await getAsset(c.get('userId'), c.req.param('id'))));
