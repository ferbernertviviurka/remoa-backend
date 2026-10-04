import { Hono } from 'hono';
import { parseWith, generateBoardInputSchema, generatePdfBoardInputSchema, idSchema } from '@remoa/contracts';
import type { Env } from '../app';
import { fail } from '../app';
import { bodyLimit } from 'hono/body-limit';
import { generationOf, startPdfGeneration, openGradeStream, attachRubric, startGeneration } from '../ai/service';
import { MAX_UPLOAD_BYTES } from '../uploads/uploads';

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
  // D-499: only for the caller's own card (ownership + quota in attachRubric). The free-text form had no caller and spent AI without quota.
  .post('/rubric', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { cardId?: unknown } | null;
    if (!idSchema.safeParse(body?.cardId).success || typeof body?.cardId !== 'string') return fail({ code: 'validation', message: 'cardId' });
    const saved = await attachRubric(c.get('userId'), body.cardId);
    if (!saved.ok) return fail(saved.error);
    return Response.json({ ok: true, data: saved.data });
  })
  // Same byte cap as uploads; anything that is not a PDF is refused before OCR.
  // D-532: multipart `file` + `board` (JSON, like the import) so the map is born with area, items and access.
  .post('/generate-pdf', bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: () => fail({ code: 'validation', message: 'pdf_too_large' }) }), async (c) => {
    const form = await c.req.parseBody();
    if (!(form.file instanceof File)) return fail({ code: 'validation', message: 'pdf_invalid' });
    const bytes = new Uint8Array(await form.file.arrayBuffer());
    let board: unknown;
    try { board = JSON.parse(String(form.board)); } catch { board = null; }
    const input = parseWith(generatePdfBoardInputSchema, board);
    if (!input.ok) return fail(input.error);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') return fail({ code: 'validation', message: 'pdf_invalid' });
    const r = await startPdfGeneration(c.get('userId'), input.data, bytes);
    if (!r.ok) return fail(r.error);
    return Response.json({ ok: true, data: r.data });
  })
  .post('/generate-board', bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: () => fail({ code: 'validation', message: 'too_large' }) }), async (c) => {
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
