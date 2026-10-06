import { Hono } from 'hono';
import { confirmAvatarInputSchema, errorHttpStatus, parseWith, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { confirmAvatar, processAvatar, removeAvatar } from '../account/avatar';
import { imageBodyLimit, readImageForm } from './uploads';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const accountAvatarRoutes = new Hono<Env>()
  .post('/avatar', async (c) => {
    const input = parseWith(confirmAvatarInputSchema, await c.req.json().catch(() => null));
    const r = input.ok ? await confirmAvatar(c.get('userId'), input.data) : input;
    if (!r.ok) c.get('log').warn('avatar rejected', { code: r.error.code });
    return send(r);
  })
  // D-1202: multipart `file` up to 100 MB, compressed server-side (no browser PUT to the bucket).
  .post('/avatar/direct', imageBodyLimit, async (c) => {
    const form = await readImageForm(c.req.raw);
    const r = form.ok ? await processAvatar(c.get('userId'), form.data.bytes) : form;
    if (!r.ok) c.get('log').warn('avatar rejected', { code: r.error.code });
    return send(r);
  })
  .delete('/avatar', async (c) => send(await removeAvatar(c.get('userId'))));
