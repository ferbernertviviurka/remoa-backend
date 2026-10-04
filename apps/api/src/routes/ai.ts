import { Hono } from 'hono';
import { parseWith, generateBoardInputSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { fail } from '../app';
import { generationOf, startPdfGeneration, openGradeStream, rubricForCard, attachRubric, startGeneration } from '../ai/service';

export const aiRoutes = new Hono<Env>()
  .post('/grade', async (c) => {
    const opened = await openGradeStream(c.get('userId'), await c.req.json().catch(() => null));
    if (!opened.ok) return fail(opened.error);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for await (const event of opened.events) {
          if (event.feedback) controller.enqueue(enc.encode(`data: ${JSON.stringify({ feedback: event.feedback })}\n\n`));
          if (event.verdict) controller.enqueue(enc.encode(`data: ${JSON.stringify({ verdict: event.verdict })}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  })
  .post('/rubric', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { title?: string; back?: string | null; source?: string; cardId?: string } | null;
    if (body?.cardId) {
      const saved = await attachRubric(c.get('userId'), body.cardId);
      if (!saved.ok) return fail(saved.error);
      return Response.json({ ok: true, data: saved.data });
    }
    if (!body?.title || !body.source) return fail({ code: 'validation', message: 'title and source' });
    const r = await rubricForCard(body.title, body.back ?? null, body.source);
    return Response.json({ ok: true, data: r.data, promptVersion: r.promptVersion });
  })
  .post('/generate-pdf', async (c) => {
    const title = c.req.query('title')?.trim();
    if (!title) return fail({ code: 'validation', message: 'title' });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const r = startPdfGeneration(c.get('userId'), title, bytes);
    return Response.json({ ok: true, data: r.data });
  })
  .post('/generate-board', async (c) => {
    const input = parseWith(generateBoardInputSchema, await c.req.json().catch(() => null));
    if (!input.ok) return fail(input.error);
    const job = await startGeneration(c.get('userId'), input.data);
    if (!job.ok) return fail(job.error);
    return Response.json({ ok: true, data: { jobId: job.data.jobId } });
  })
  .get('/jobs/:id', (c) => {
    const job = generationOf(c.get('userId'), c.req.param('id'));
    if (!job) return fail({ code: 'not_found', message: 'job not found' });
    return Response.json({ ok: true, data: job });
  });
