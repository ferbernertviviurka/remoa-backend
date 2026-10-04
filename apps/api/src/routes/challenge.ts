import { Hono } from 'hono';
import { z } from 'zod';
import {
  answerInputSchema, errorHttpStatus, idSchema, itemRefSchema, parseWith, rateInputSchema, startSessionInputSchema, type GradeAnswer, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { createAnswer, createAnswerStream, dispute, finishSession, rate, skip, startSession, type AnswerStreamEvent, type GradeStream } from '../challenge/session';

export type { GradeStream };

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

const finishInput = z.object({ sessionId: idSchema });

function sse(events: AsyncGenerator<AnswerStreamEvent>) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: { code: 'internal', message: 'grade failed' } })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
}

/** F04. `grade` is the F05 grader port (D-061); absent = text answers fall back to `grader_error`. `stream` sends feedback before the verdict. */
export const challengeRoutes = ({ grade, stream }: { grade?: GradeAnswer; stream?: GradeStream }) => {
  const answer = createAnswer(grade);
  const streamed = createAnswerStream(grade, stream);
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  return new Hono<Env>()
    .post('/start', async (c) => {
      const i = parseWith(startSessionInputSchema, await body(c));
      return send(i.ok ? await startSession(c.get('userId'), i.data) : i);
    })
    .post('/answer', async (c) => {
      const i = parseWith(answerInputSchema, await body(c));
      if (!i.ok) return send(i);
      const live = Boolean(stream) && (c.req.header('accept') ?? '').includes('text/event-stream');
      if (!live) return send(await answer(c.get('userId'), i.data));
      return sse(streamed(c.get('userId'), i.data));
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
