import { Hono } from 'hono';
import type { Env } from '../app';
import { getCoverage } from '../matrix/matrix';

export const coverageRoutes = new Hono<Env>().get('/', async (c) => {
  const r = await getCoverage(c.get('userId'));
  return Response.json({ ok: true, data: r.ok ? r.data : [] });
});
