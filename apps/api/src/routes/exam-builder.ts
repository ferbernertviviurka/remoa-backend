import { Hono } from 'hono';
import {
  EXAM_GENERATE_CHUNK, examBoardContentQuerySchema, examBuilderFilterSchema, examGenerateInputSchema, examGenerateResultSchema, examPreviewInputSchema,
  examRevalidateInputSchema, examSwapInputSchema, type AppError, type ExamGenerateResult, type Result,
} from '@remoa/contracts';
import type { Env } from '../app';
import { parseQuestionInput, questionResponse } from './questions';
import { fail } from '../app';
import { generateQuestions } from '../challenge-ai/generate';
import { takeAiSlot } from './challenge-ai';
import { examBuilder } from '../questions/builder/service';
import { EXTRA_BATCHES, generateFromTopics } from '../questions/builder/generate-topic';

type Generated = { questions: { id: string }[]; requested: number; reused: number; generated: number; shortfall: number; stoppedBy: null | 'quota' | 'ai_error'; discarded: Partial<Record<string, number>> };

/** D-1882: why the request came back short, for a readable message (contract: examGenerateShortfallReasons). */
export function shortfallReason(d: Generated): ExamGenerateResult['shortfallReason'] {
  if (!d.shortfall) return null;
  if (d.stoppedBy) return d.stoppedBy;
  const { untagged = 0, ...guards } = d.discarded;
  return untagged > 0 && !Object.values(guards).some((n) => (n ?? 0) > 0) ? 'unclassified' : 'rejected';
}
const toResult = (d: Generated) => examGenerateResultSchema.parse({
  questionIds: d.questions.map((q) => q.id), requested: d.requested, reused: d.reused, generated: d.generated, shortfall: d.shortfall, stoppedBy: d.stoppedBy, shortfallReason: shortfallReason(d),
});

/** D-1882: SSE `{progress}` events, then one `{result}` or `{error}`. A closed client does not stop the generation (rows are saved, quota spent). */
function sse(work: (progress: (generated: number) => void) => Promise<Result<ExamGenerateResult>>, requested: number, log: Env['Variables']['log']) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      let open = true, last = -1;
      const send = (event: unknown) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { open = false; }
      };
      try {
        const r = await work((generated) => { if (generated > last) { last = generated; send({ progress: { generated, requested } }); } });
        send(r.ok ? { result: r.data } : { error: r.error });
      } catch (e) {
        log.error('exam_generate_failed', { event: 'exam_generate_failed', type: e instanceof Error ? e.name : 'unknown' });
        send({ error: { code: 'internal', message: 'generate failed' } satisfies AppError });
      } finally {
        if (open) controller.close();
      }
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
}

/** F34 FR-24..28: mounted behind requireUser + catalog + bankStudent. Read-only; no response carries an answer key (D-1822). */
/** D-1846: generators are injectable so route tests never reach a provider (rule 13). */
export function examBuilderRoutes(generate: typeof generateQuestions = generateQuestions, generateTopic: typeof generateFromTopics = generateFromTopics) {
  return new Hono<Env>()
    .post('/availability', c => questionResponse(async () => examBuilder.availability(c.get('userId'), parseQuestionInput(examBuilderFilterSchema, await c.req.json().catch(() => null)))))
    .post('/preview', c => questionResponse(async () => examBuilder.preview(c.get('userId'), parseQuestionInput(examPreviewInputSchema, await c.req.json().catch(() => null)))))
    .post('/swap', c => questionResponse(async () => examBuilder.swap(c.get('userId'), parseQuestionInput(examSwapInputSchema, await c.req.json().catch(() => null)))))
    // D-1882 (E): the "Conteúdo" step prefilled from a map; 404 for a map that is not the caller's.
    .get('/board-content', c => questionResponse(async () => examBuilder.boardContent(c.get('userId'), parseQuestionInput(examBoardContentQuerySchema, { boardId: c.req.query('boardId') }).boardId)))
    // D-1846 map mode / D-1882 theme mode. Ids + counts only, never a stem or key. `Accept: text/event-stream` streams real progress.
    .post('/generate', async c => {
      const userId = c.get('userId');
      const parsed = examGenerateInputSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return fail({ code: 'validation', message: 'invalid_question_input' });
      const slot = takeAiSlot(userId);
      if (!slot.ok) { const res = fail(slot.error); res.headers.set('retry-after', '60'); return res; }
      const { boardId, areaIds, topicIds, theme, count, difficulty } = parsed.data;
      const requestId = c.get('requestId');
      const work = async (onProgress?: (generated: number) => void): Promise<Result<ExamGenerateResult>> => {
        const r = boardId
          ? await generate({ userId, boardId, scope: { kind: 'board' }, n: count, questionType: 'objective', difficulty, requestId, batchSize: EXAM_GENERATE_CHUNK, extraBatches: EXTRA_BATCHES, onProgress })
          : await generateTopic({ userId, areaIds, topicIds, theme, n: count, difficulty, requestId, onProgress });
        return r.ok ? { ok: true, data: toResult(r.data) } : r;
      };
      if ((c.req.header('accept') ?? '').includes('text/event-stream')) return sse(work, count, c.get('log'));
      const r = await work();
      return r.ok ? Response.json({ ok: true, data: r.data }) : fail(r.error);
    })
    .post('/revalidate', c => questionResponse(async () => examBuilder.revalidate(c.get('userId'), parseQuestionInput(examRevalidateInputSchema, await c.req.json().catch(() => null)))));
}
