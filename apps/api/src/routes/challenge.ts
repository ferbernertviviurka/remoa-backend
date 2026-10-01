import { Hono } from 'hono';
import { z } from 'zod';
import {
  answerInputSchema, errorHttpStatus, idSchema, itemRefSchema, parseWith, rateInputSchema, startSessionInputSchema, type GradeAnswer, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { createAnswer, dispute, finishSession, rate, skip, startSession } from '../challenge/session';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const finishInput = z.object({ sessionId: idSchema });

/** F04. `grade` is the F05 grader port (D-061); absent = text answers fall back to `grader_error`. */
export const challengeRoutes = ({ grade }: { grade?: GradeAnswer }) => {
  const answer = createAnswer(grade);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  return new Hono<Env>()
    .post('/start', async (c) => {
      const i = parseWith(startSessionInputSchema, await body(c));
      return send(i.ok ? await startSession(c.get('userId'), i.data) : i);
    })
    .post('/answer', async (c) => {
      const i = parseWith(answerInputSchema, await body(c));
      return send(i.ok ? await answer(c.get('userId'), i.data) : i);
    })
    .post('/rate', async (c) => {
      const i = parseWith(rateInputSchema, await body(c));
      return send(i.ok ? await rate(c.get('userId'), i.data) : i);
    })
    .post('/dispute', async (c) => {
      const i = parseWith(itemRefSchema, await body(c));
      return send(i.ok ? await dispute(c.get('userId'), i.data) : i);
    })
    .post('/skip', async (c) => {
      const i = parseWith(itemRefSchema, await body(c));
      return send(i.ok ? await skip(c.get('userId'), i.data) : i);
    })
    .post('/finish', async (c) => {
      const i = parseWith(finishInput, await body(c));
      return send(i.ok ? await finishSession(c.get('userId'), i.data.sessionId) : i);
    });
};
