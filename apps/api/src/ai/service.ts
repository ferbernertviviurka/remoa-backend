import { eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { AI_DRAFT_SOURCE, graderInputSchema, rubricSchema, err, ok, parseWith, type BoardGenerationProgress, type CardDraft, type GenerateBoardInput } from '@remoa/contracts';
import { cachedRubric, costCents, extractWithMeta, EXTRACT_PROMPT_VERSION, gradeWithMeta, layout, ocrPdf, pdfPageCount, pdfText, rubricWithMeta, RUBRIC_PROMPT_VERSION, streamGrade, type GradeEvent } from '@remoa/ai';
import { dispatchBoardJob } from '../inngest/client';
import { assertQuota, refundGeneration, refundQuota } from '../billing/quota';
import { dbm } from '../db';
import { getBytes } from '../storage/storage';
import { caller } from './caller';

const hits = new Map<string, number[]>();

export function allowGrade(userId: string, now = Date.now()): boolean {
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 30) {
    hits.set(userId, recent);
    return false;
  }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

const jobs = new Map<string, BoardGenerationProgress & { userId: string }>();
const work = new Map<string, { userId: string; input: GenerateBoardInput; text: string; charged: boolean; refunded: boolean; logKind?: string }>();
const counts = new Map<string, { cards: number; edges: number; pages?: number }>();

async function recordCall(userId: string, kind: string, meta: { model: string; tokensIn: number; tokensOut: number }) {
  if (!process.env.DATABASE_URL) return;
  const { db, aiCalls } = await dbm();
  await db.insert(aiCalls).values({
    userId, kind, model: meta.model, promptVersion: EXTRACT_PROMPT_VERSION, inputTokens: meta.tokensIn, outputTokens: meta.tokensOut, costCents: costCents(meta.tokensIn, meta.tokensOut, meta.model), latencyMs: 0,
  });
}

/** F04 port: OpenRouter when OPENROUTER_API_KEY is set, rubric-only grader otherwise. Logs the call when a request user is in scope. */
export async function gradeAnswer(input: Parameters<typeof gradeWithMeta>[0]) {
  const { verdict, meta } = await gradeWithMeta(input);
  const userId = caller.getStore();
  if (userId && process.env.DATABASE_URL) {
    try {
      const { db, aiCalls } = await dbm();
      await db.insert(aiCalls).values({
        userId, kind: 'grade', model: verdict.model, promptVersion: meta.promptVersion,
        inputTokens: meta.tokensIn, outputTokens: meta.tokensOut, costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model), latencyMs: meta.latencyMs,
      });
    } catch {
      /* the verdict still stands if the cost row cannot be written */
    }
  }
  return ok({ ...verdict, costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model) });
}

/** Same grader as `gradeAnswer`, but feedback leaves as the model writes it. One `ai_calls` row when a verdict arrives. */
export async function* streamGradeAnswer(input: Parameters<typeof streamGrade>[0]): AsyncGenerator<GradeEvent> {
  for await (const event of streamGrade(input)) {
    if (!event.verdict || !event.meta) {
      yield event;
      continue;
    }
    const verdict = { ...event.verdict, costCents: costCents(event.meta.tokensIn, event.meta.tokensOut, event.verdict.model) };
    const priced: GradeEvent = { ...event, verdict };
    yield priced;
    const userId = caller.getStore();
    if (!userId || !process.env.DATABASE_URL) continue;
    try {
      const { db, aiCalls } = await dbm();
      await db.insert(aiCalls).values({
        userId, kind: 'grade', model: verdict.model, promptVersion: event.meta.promptVersion,
        inputTokens: event.meta.tokensIn, outputTokens: event.meta.tokensOut, costCents: costCents(event.meta.tokensIn, event.meta.tokensOut, verdict.model), latencyMs: event.meta.latencyMs,
      });
    } catch {
      /* the streamed verdict still stands */
    }
  }
}

export async function gradeForUser(userId: string, body: unknown) {
  if (!allowGrade(userId)) return { ok: false as const, error: { code: 'rate_limited' as const, message: '30 por minuto' } };
  const input = parseWith(graderInputSchema, body);
  if (!input.ok) return input;
  if (process.env.DATABASE_URL) {
    const quota = await assertQuota(userId, 'ai_grades');
    if (!quota.ok) return quota;
  }
  try {
    const { verdict, meta } = await gradeWithMeta(input.data);
    if (process.env.DATABASE_URL) {
      const { db, aiCalls } = await dbm();
      await db.insert(aiCalls).values({
        userId,
        kind: 'grade',
        model: verdict.model,
        promptVersion: meta.promptVersion,
        inputTokens: meta.tokensIn,
        outputTokens: meta.tokensOut,
        costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model),
        latencyMs: meta.latencyMs,
      });
    }
    return { ok: true as const, data: { ...verdict, costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model) } };
  } catch {
    if (process.env.DATABASE_URL) await refundQuota(userId).catch(() => undefined);
    return { ok: false as const, error: { code: 'ai_unavailable' as const, message: 'não foi possível corrigir, revele e avalie' } };
  }
}

export async function openGradeStream(userId: string, body: unknown) {
  if (!allowGrade(userId)) return { ok: false as const, error: { code: 'rate_limited' as const, message: '30 por minuto' } };
  const input = parseWith(graderInputSchema, body);
  if (!input.ok) return { ok: false as const, error: input.error };
  if (process.env.DATABASE_URL) {
    const quota = await assertQuota(userId, 'ai_grades');
    if (!quota.ok) return { ok: false as const, error: quota.error };
  }
  return { ok: true as const, events: recordGradeStream(userId, input.data) };
}

async function* recordGradeStream(userId: string, input: Parameters<typeof streamGrade>[0]): AsyncGenerator<GradeEvent> {
  let last: GradeEvent | undefined;
  for await (const event of streamGrade(input)) {
    if (!event.verdict || !event.meta) {
      yield event;
      continue;
    }
    const priced: GradeEvent = { ...event, verdict: { ...event.verdict, costCents: costCents(event.meta.tokensIn, event.meta.tokensOut, event.verdict.model) } };
    last = priced;
    yield priced;
  }
  const verdict = last?.verdict;
  const meta = last?.meta;
  if (!verdict || !meta || !process.env.DATABASE_URL) return;
  try {
    const { db, aiCalls } = await dbm();
    await db.insert(aiCalls).values({
      userId, kind: 'grade', model: verdict.model, promptVersion: meta.promptVersion,
      inputTokens: meta.tokensIn, outputTokens: meta.tokensOut, costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model), latencyMs: meta.latencyMs,
    });
  } catch {
    /* the streamed verdict still stands */
  }
}

export async function rubricForCard(title: string, back: string | null, source: string) {
  const { rubric, meta } = await rubricWithMeta(title, back, source);
  const userId = caller.getStore();
  if (userId && process.env.DATABASE_URL) {
    try {
      const { db, aiCalls } = await dbm();
      await db.insert(aiCalls).values({
        userId, kind: 'rubric', model: meta.model, promptVersion: RUBRIC_PROMPT_VERSION,
        inputTokens: meta.tokensIn, outputTokens: meta.tokensOut, costCents: costCents(meta.tokensIn, meta.tokensOut, meta.model), latencyMs: 0,
      });
    } catch {
      /* the rubric still returns if the cost row cannot be written */
    }
  }
  return { ok: true as const, data: rubric, promptVersion: RUBRIC_PROMPT_VERSION };
}

/** Writes a draft rubric on the user's card. An approved rubric stays as it is. */
export async function attachRubric(userId: string, cardId: string) {
  const { db, cards, boards, aiCalls } = await dbm();
  const [card] = await db.select().from(cards).where(eq(cards.id, cardId));
  if (!card || card.deletedAt) return err('not_found', 'not found');
  const [board] = await db.select().from(boards).where(eq(boards.id, card.boardId));
  if (!board || board.userId !== userId) return err('not_found', 'not found');
  const existing = card.rubric && typeof card.rubric === 'object' ? card.rubric as { status?: string; inputHash?: string } : null;
  if (existing?.status === 'approved') return err('conflict', 'approved rubric');
  const source = card.source?.trim() || AI_DRAFT_SOURCE;
  const hash = createHash('sha256').update(`${card.title}\n${card.back ?? ''}\n${source}`).digest('hex');
  if (existing?.status === 'draft' && existing.inputHash === hash) {
    const parsed = rubricSchema.safeParse(existing);
    if (parsed.success) return ok(parsed.data);
  }
  const remembered = cachedRubric(card.title, card.back, source);
  if (remembered) {
    await db.update(cards).set({ rubric: { ...remembered, inputHash: hash }, updatedAt: new Date() }).where(eq(cards.id, card.id));
    return ok(remembered);
  }
  const charged = Boolean(process.env.DATABASE_URL && process.env.OPENROUTER_API_KEY);
  if (charged) {
    const quota = await assertQuota(userId, 'ai_grades');
    if (!quota.ok) return quota;
  }
  let built: Awaited<ReturnType<typeof rubricWithMeta>>;
  try {
    built = await rubricWithMeta(card.title, card.back, source);
  } catch (error) {
    if (charged) await refundQuota(userId).catch(() => undefined);
    throw error;
  }
  const { rubric, meta } = built;
  await db.update(cards).set({ rubric: { ...rubric, inputHash: hash }, updatedAt: new Date() }).where(eq(cards.id, card.id));
  if (process.env.DATABASE_URL) {
    await db.insert(aiCalls).values({
      userId, kind: 'rubric', model: meta.model, promptVersion: RUBRIC_PROMPT_VERSION,
      inputTokens: meta.tokensIn, outputTokens: meta.tokensOut, costCents: costCents(meta.tokensIn, meta.tokensOut, meta.model), latencyMs: 0,
    });
  }
  return ok(rubric);
}

async function saveBoard(userId: string, input: GenerateBoardInput, cards: CardDraft[], edges: { fromRef: string; toRef: string; label: string | null }[]) {
  const { db, boards, cards: cardTable, edges: edgeTable } = await dbm();
  const places = new Map(layout(cards, edges).map((p) => [p.ref, p]));
  const [board] = await db.insert(boards).values({ userId, title: input.title, area: input.area, status: 'private' }).returning();
  const ids = new Map<string, string>();
  let order = 0;
  for (const card of cards) {
    if (card.type === 'image') continue;
    const place = places.get(card.ref);
    const [row] = await db.insert(cardTable).values({
      boardId: board!.id,
      type: card.type,
      title: card.title,
      front: card.front,
      back: card.back,
      source: card.source ?? AI_DRAFT_SOURCE,
      payload: card.payload,
      status: 'draft',
      order,
      x: place?.x ?? 80,
      y: place?.y ?? 80,
    }).returning();
    ids.set(card.ref, row!.id);
    order += 1;
  }
  for (const edge of edges) {
    const fromCardId = ids.get(edge.fromRef);
    const toCardId = ids.get(edge.toRef);
    if (fromCardId && toCardId) await db.insert(edgeTable).values({ boardId: board!.id, fromCardId, toCardId, label: edge.label });
  }
  return board!.id;
}

async function readableText(bytes: Uint8Array): Promise<string> {
  const literal = pdfText(bytes);
  return literal.length >= 40 ? literal : ocrPdf(bytes);
}

async function pdfSource(userId: string, assetId: string): Promise<string> {
  const { db, assets } = await dbm();
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset || asset.userId !== userId) throw new Error('pdf_not_found');
  const text = await readableText(await getBytes(asset.key));
  if (text.length < 40) throw new Error('pdf_unreadable');
  return text;
}

function failJob(jobId: string, error: string) {
  const job = jobs.get(jobId);
  if (job) jobs.set(jobId, { ...job, status: 'failed', stage: job.stage, error });
}

/** Starts the PDF job and returns immediately. OCR, quota and extraction run after, so the screen can show 0–100. An unreadable PDF never spends a generation. */
export function startPdfGeneration(userId: string, title: string, bytes: Uint8Array) {
  const jobId = randomUUID();
  jobs.set(jobId, { jobId, userId, status: 'queued', progress: 0, stage: 'ocr', boardId: null, error: null });
  counts.set(jobId, { cards: 0, edges: 0, pages: pdfPageCount(bytes) });
  void (async () => {
    const reading = jobs.get(jobId);
    if (reading) jobs.set(jobId, { ...reading, status: 'running', progress: 10, stage: 'ocr' });
    let text: string;
    try {
      text = await readableText(bytes);
    } catch (e) {
      failJob(jobId, e instanceof Error ? e.message : 'failed');
      return;
    }
    if (text.length < 40) {
      failJob(jobId, 'pdf_unreadable');
      return;
    }
    const charged = await chargeGeneration(userId);
    if (!charged.ok) {
      failJob(jobId, charged.error.message);
      return;
    }
    const current = jobs.get(jobId);
    if (!current || current.status === 'failed') return;
    jobs.set(jobId, { ...current, status: 'queued', progress: 20, stage: 'extract' });
    work.set(jobId, {
      userId,
      input: { kind: 'text', text, area: 'CM', title },
      text,
      charged: charged.charged,
      refunded: false,
      logKind: 'generate_pdf',
    });
    const sent = await dispatchBoardJob(jobId).catch(() => false);
    if (!sent) await executeGeneration(jobId);
  })();
  return { ok: true as const, data: { jobId } };
}

async function chargeGeneration(userId: string) {
  if (!process.env.DATABASE_URL) return { ok: true as const, charged: false };
  const quota = await assertQuota(userId, 'ai_generations');
  if (!quota.ok) return { ok: false as const, error: quota.error, charged: false };
  return { ok: true as const, charged: true };
}

export async function startGeneration(userId: string, input: GenerateBoardInput) {
  let text: string;
  try {
    text = input.kind === 'text' ? input.text : await pdfSource(userId, input.pdfAssetId);
  } catch (e) {
    return { ok: false as const, error: { code: 'validation' as const, message: e instanceof Error ? e.message : 'failed' } };
  }
  if (input.kind === 'pdf' && text.length < 40) return { ok: false as const, error: { code: 'validation' as const, message: 'pdf_unreadable' } };
  const charged = await chargeGeneration(userId);
  if (!charged.ok) return charged;
  const jobId = randomUUID();
  jobs.set(jobId, { jobId, userId, status: 'queued', progress: 0, stage: 'extract', boardId: null, error: null });
  work.set(jobId, { userId, input, text, charged: charged.charged, refunded: false });
  const sent = await dispatchBoardJob(jobId).catch(() => false);
  if (!sent) void runGeneration(jobId);
  return { ok: true as const, data: { jobId, status: 'queued' as const, progress: 0, stage: 'extract' as const, boardId: null, error: null } };
}

export async function runGeneration(jobId: string) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return;
  await executeGeneration(jobId);
}

async function executeGeneration(jobId: string) {
  const job = jobs.get(jobId);
  const item = work.get(jobId);
  if (!job || !item || job.status === 'done' || job.status === 'failed') return;
  jobs.set(jobId, { ...job, status: 'running', progress: Math.max(job.progress, 30), stage: 'extract' });
  try {
    const { extracted, meta } = await extractWithMeta(item.text, AI_DRAFT_SOURCE);
    counts.set(jobId, { cards: extracted.cards.length, edges: extracted.edges.length, pages: counts.get(jobId)?.pages });
    const current = jobs.get(jobId);
    if (current) jobs.set(jobId, { ...current, progress: 75, stage: 'layout' });
    const boardId = process.env.DATABASE_URL ? await saveBoard(item.userId, item.input, extracted.cards, extracted.edges) : null;
    await recordCall(item.userId, item.logKind ?? (item.input.kind === 'pdf' ? 'generate_pdf' : 'generate_text'), meta);
    const done = jobs.get(jobId);
    if (done) jobs.set(jobId, { ...done, status: 'done', progress: 100, stage: null, boardId });
    work.delete(jobId);
  } catch (e) {
    if (item.charged && !item.refunded) {
      item.refunded = true;
      await refundGeneration(item.userId).catch(() => undefined);
    }
    const failed = jobs.get(jobId);
    if (failed) jobs.set(jobId, { ...failed, status: 'failed', progress: 100, stage: null, error: e instanceof Error ? e.message : 'failed' });
  }
}

export function generationOf(userId: string, jobId: string): (BoardGenerationProgress & { cards?: number; edges?: number; pages?: number }) | null {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  const n = counts.get(jobId);
  return { jobId: job.jobId, status: job.status, progress: job.progress, stage: job.stage, boardId: job.boardId, error: job.error, ...(n ?? {}) };
}
