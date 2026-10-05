import { Hono } from 'hono';
import { errorHttpStatus, idSchema, parseWith, queueQuerySchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import { z } from 'zod';
import type { Env } from '../app';
import { setCardStudy } from '../review/study';
import { getReviewHub } from '../review/hub';
import { getBoardQueue, getDailyQueue, getRetrievability } from '../review/queue';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const retrievabilityQuery = z.object({ boardId: idSchema });

export const reviewRoutes = new Hono<Env>()
  .get('/queue', async (c) => {
    const q = parseWith(queueQuerySchema, c.req.query());
    if (!q.ok) return send(q);
    const opts = { now: new Date(), limit: q.data.limit };
    return send(q.data.boardId ? await getBoardQueue(c.get('userId'), q.data.boardId, opts) : await getDailyQueue(c.get('userId'), opts));
  })
  .get('/hub', async (c) => send(await getReviewHub(c.get('userId'), new Date())))
  .post('/cards/:id/:action', async (c) => send(await setCardStudy(c.get('userId'), c.req.param('id'), c.req.param('action') as never)))
  .get('/retrievability', async (c) => {
    const q = parseWith(retrievabilityQuery, c.req.query());
    return send(q.ok ? await getRetrievability(c.get('userId'), q.data.boardId, new Date()) : q);
  });
