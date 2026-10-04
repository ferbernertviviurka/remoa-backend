import { Hono } from 'hono';
import type { Env } from '../app';
import { getProgress, attemptsCsv } from '../reports/progress';

const send = (r: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error }, { status: 500 });

export const reportsRoutes = new Hono<Env>()
  .get('/progress', async (c) => send(await getProgress(c.get('userId'), new Date())))
  .get('/attempts.csv', async (c) => {
    const csv = await attemptsCsv(c.get('userId'));
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
  });
