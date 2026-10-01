import { Hono } from 'hono';
import { errorHttpStatus, parseWith, saveCardInputSchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { getCard, saveCard } from '../cards/cards';

const send = <T>(r: Result<T>) =>
  r.ok
    ? Response.json({ ok: true, data: r.data })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const cardsRoutes = new Hono<Env>()
  .get('/:id', async (c) => send(await getCard(c.get('userId'), c.req.param('id'))))
  .put('/:id', async (c) => {
    const input = parseWith(saveCardInputSchema, await c.req.json().catch(() => null));
    return send(input.ok ? await saveCard(c.get('userId'), c.req.param('id'), input.data) : input);
  });
