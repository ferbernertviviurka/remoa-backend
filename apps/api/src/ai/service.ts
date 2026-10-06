import { notifyMapReady } from '../notifications/map-ready';
import { pick } from '../pick';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import {
  AI_DRAFT_SOURCE, OFFLINE_DRAFT_SOURCE, generatePdfBoardInputSchema, graderInputSchema, planDefinition, rubricSchema, err, ok, parseWith,
  type AiInfo, type AiQuota, type AppError, type BoardGenerationProgress, type CardDraft, type GenerateBoardInput, type GraderVerdict,
} from '@remoa/contracts';
import {
  AI_ERROR_MESSAGES, AiError, aiMode, aiUsage, cachedRubric, costCents, extractWithMeta, EXTRACT_PROMPT_VERSION, gradeWithMeta, layout, ocrPdf,
  pdfPageCount, readPdfText, rubricWithMeta, RUBRIC_PROMPT_VERSION, streamGrade, type GradeEvent,
} from '@remoa/ai';
import type { Tx } from '@remoa/db';
import { dispatchBoardJob, inngest, inngestConfigured } from '../inngest/client';
import { assertQuota, liveCardsSql, reserveAi, type Reservation } from '../billing/quota';
import { planOf } from '../billing/plan';
import { dbm, run } from '../db';
import { maybeQualifyReferral } from '../referral/qualify';
import { initialShareColumns } from '../share/crypto';
import type { z } from 'zod';
import { getBytes } from '../storage/storage';
import { caller } from './caller';
import { createLogger } from '@remoa/log';
import { invalidate } from '../cache';

/** D-582: a failed job answers 200 on /jobs/:id, so its reason only shows up in the API log through this line. */
const logFailed = (jobId: string, error: string) => createLogger({ requestId: jobId }).warn('generation failed', { jobId, error });

/** A service failure; `retryAfter` (seconds) becomes the Retry-After header of a 429; `ai` says what happened with the model. */
export type AiFailure = { ok: false; error: AppError; retryAfter?: number; ai?: AiInfo };

const hits = new Map<string, number[]>();

/** Per-user sliding minute. ponytail: in-process memory (one instance); a shared store (Postgres/Redis) when the API scales out. */
export function allow(bucket: 'grade' | 'rubric' | 'generate', userId: string, max: number, now = Date.now()): boolean {
  const key = `${bucket}:${userId}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  const allowed = recent.length < max;
  if (allowed) recent.push(now);
  hits.set(key, recent);
  return allowed;
}

export const allowGrade = (userId: string, now = Date.now()) => allow('grade', userId, 30, now);
const RUBRIC_PER_MINUTE = 30;
const GENERATE_PER_MINUTE = 5;
const limited: AiFailure = { ok: false, error: { code: 'rate_limited', message: 'rate_limited' }, retryAfter: 60 };
/** D-580: no OPENROUTER_API_KEY and no AI=mock. 503 before anything is charged; the log line says which env var is missing. */
const aiOff: AiFailure = { ok: false, error: { code: 'ai_unavailable', message: 'ai_not_configured' } };

// --- G22: what happened with the model, telemetry, dedup ------------------------------------------------------------

/** The provider failure packages/ai attaches to `meta` when it fell back to the local grader/extractor (G22). */
const errorOf = (meta: object): AiError | undefined => ('error' in meta && meta.error instanceof AiError ? meta.error : undefined);
const OK: AiInfo = { status: 'ok', code: null, message: null };
const failedInfo = (status: 'fallback' | 'error', code: string, message: string): AiInfo => ({ status, code, message });
/** Job and server failure codes that are not an AiErrorCode, with the text to show (D-1413). */
const JOB_MESSAGES: Record<string, string> = {
  canceled: 'Geração cancelada.',
  pdf_unreadable: 'Não conseguimos ler o texto desse PDF.',
  no_content: 'Não encontramos conteúdo para estudar nesse texto.',
  no_sourced_cards: 'A IA não conseguiu apontar no texto a origem de nenhum card. Tente de novo.',
  generate_timeout: AI_ERROR_MESSAGES.timeout,
  boards: 'Você atingiu o limite de mapas do seu plano.',
  cards: 'Você atingiu o limite de cards do seu plano.',
  offline: 'Correção automática, sem IA.',
};
const messageOf = (code: string) => (AI_ERROR_MESSAGES as Record<string, string>)[code] ?? JOB_MESSAGES[code] ?? AI_ERROR_MESSAGES.provider_error;

/**
 * The verdict's AI status. `fallback` = the local grader answered (provider error, AI off, or a blank answer graded locally);
 * the quota is given back for it. AI=mock is the configured grader in dev/e2e: `ok`.
 */
function gradeInfo(model: string, error: AiError | undefined): AiInfo {
  if (error) return failedInfo('fallback', error.code, error.userMessage);
  if (!model.startsWith('offline')) return OK;
  const mode = aiMode();
  if (mode === 'mock') return OK;
  return failedInfo('fallback', mode === 'off' ? 'not_configured' : 'offline', mode === 'off' ? AI_ERROR_MESSAGES.not_configured : JOB_MESSAGES.offline!);
}

/** CCR-071: `ai_call` per AI operation and `ai_error` when it was not ok. Log lines with `event` (the server events path), never content. */
function track(fn: 'grade' | 'rubric' | 'extract', model: string, latencyMs: number, info: AiInfo, requestId = 'ai') {
  const log = createLogger({ requestId });
  log.info('ai_call', { event: 'ai_call', fn, model: model.slice(0, 80) || 'none', latencyMs: Math.max(0, Math.round(latencyMs)), status: info.status });
  if (info.code) log.warn('ai_error', { event: 'ai_error', fn, type: info.code });
}

/** AI limits of the app (packages/ai counter): 429 with Retry-After before any quota is taken. Only when the model is live. */
export function providerRoom(now = Date.now()): { ok: true } | AiFailure {
  if (aiMode() !== 'live') return { ok: true };
  const u = aiUsage(now);
  if (u.day >= u.rpdLimit) {
    const midnight = Date.parse(`${u.utcDay}T00:00:00Z`) + 86_400_000;
    return { ok: false, error: { code: 'rate_limited', message: AI_ERROR_MESSAGES.quota_exceeded }, retryAfter: Math.max(1, Math.ceil((midnight - now) / 1000)), ai: failedInfo('error', 'quota_exceeded', AI_ERROR_MESSAGES.quota_exceeded) };
  }
  if (u.minute >= u.rpmLimit) return { ok: false, error: { code: 'rate_limited', message: AI_ERROR_MESSAGES.rate_limited }, retryAfter: 60, ai: failedInfo('error', 'rate_limited', AI_ERROR_MESSAGES.rate_limited) };
  return { ok: true };
}

/** A model failure as an API error: the local limit is a 429 with Retry-After, anything else 503 with the friendly message. */
function aiFailure(e: AiError): AiFailure {
  const ai = failedInfo('error', e.code, e.userMessage);
  if (e.local || e.code === 'rate_limited') return { ok: false, error: { code: 'rate_limited', message: e.userMessage }, retryAfter: e.code === 'quota_exceeded' ? 3600 : 60, ai };
  return { ok: false, error: { code: 'ai_unavailable', message: e.userMessage }, ai };
}

const inflight = new Map<string, Promise<unknown>>();
/** G22 (D-1418): identical calls of the same user already running share one promise. No AI response is cached (F26). */
function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit) return hit as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** F14 FR-19 (D-499): a generated map is a new board, so the Free 2-map cap applies before any AI is spent (402 like the other paths). */
async function boardRoom(userId: string) {
  if (!process.env.DATABASE_URL) return { ok: true as const };
  const quota = await assertQuota(userId, 'boards');
  return quota.ok ? { ok: true as const } : { ok: false as const, error: quota.error };
}

/** G22 (D-1414): cards the plan still allows (PlanDefinition `cards` minus live cards); null = unlimited. */
async function cardRoom(userId: string): Promise<number | null> {
  const limit = planDefinition((await planOf(userId)).plan).cards;
  if (limit === null) return null;
  const { db } = await dbm();
  const [r] = await db.execute<{ n: number }>(sql`select (${liveCardsSql(userId)}) as n`);
  return Math.max(0, limit - r!.n);
}

async function recordCall(userId: string, kind: string, meta: { model: string; promptVersion: string; tokensIn: number; tokensOut: number; latencyMs: number }): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { db, aiCalls } = await dbm();
    const id = randomUUID();
    await db.insert(aiCalls).values({
      id, userId, kind, model: meta.model, promptVersion: meta.promptVersion, inputTokens: meta.tokensIn, outputTokens: meta.tokensOut,
      costCents: costCents(meta.tokensIn, meta.tokensOut, meta.model), latencyMs: meta.latencyMs,
    });
    return id;
  } catch {
    return null; // the verdict still stands if the cost row cannot be written
  }
}

// --- correction ---------------------------------------------------------------------------------------------------

/** One graded call: priced, recorded (its id is the flag target) and tracked, with the AI status on the verdict. */
async function finishGrade<V extends GraderVerdict>(userId: string | undefined, verdict: V, meta: NonNullable<GradeEvent['meta']>): Promise<V> {
  const info = gradeInfo(verdict.model, errorOf(meta));
  const callId = userId ? await recordCall(userId, 'grade', { model: verdict.model, ...meta }) : null;
  track('grade', verdict.model, meta.latencyMs, info, callId ?? undefined);
  return { ...verdict, costCents: costCents(meta.tokensIn, meta.tokensOut, verdict.model), ai: { ...info, callId } };
}

/** F04 port: the model when configured, the local grader otherwise or on failure (then `ai.status = 'fallback'`). */
export async function gradeAnswer(input: Parameters<typeof gradeWithMeta>[0]) {
  const { verdict, meta } = await gradeWithMeta(input);
  return ok(await finishGrade(caller.getStore(), verdict, meta));
}

/** Same grader as `gradeAnswer`, but feedback leaves as the model writes it. One `ai_calls` row, written before the verdict leaves. */
export async function* streamGradeAnswer(input: Parameters<typeof streamGrade>[0], userId = caller.getStore()): AsyncGenerator<GradeEvent> {
  for await (const event of streamGrade(input)) {
    if (!event.verdict || !event.meta) {
      yield event;
      continue;
    }
    yield { ...event, verdict: await finishGrade(userId, event.verdict, event.meta) };
  }
}

/** POST /v1/ai/grade: rate limit, app AI limit (429 + Retry-After), then one ai_grades unit held until the verdict says ok. */
export async function openGradeStream(userId: string, body: unknown) {
  if (!allowGrade(userId)) return limited;
  const input = parseWith(graderInputSchema, body);
  if (!input.ok) return { ok: false as const, error: input.error };
  const room = providerRoom();
  if (!room.ok) return room;
  let held: Reservation | null = null;
  if (process.env.DATABASE_URL) {
    const r = await reserveAi(userId, 'ai_grades');
    if (!r.ok) return { ok: false as const, error: r.error };
    held = r;
  }
  return { ok: true as const, events: holdGradeStream(userId, input.data, held) };
}

/** Only a model verdict keeps the unit: a fallback, an error or a client that left before the verdict gives it back. */
async function* holdGradeStream(userId: string, input: Parameters<typeof streamGrade>[0], held: Reservation | null): AsyncGenerator<GradeEvent> {
  let kept = false;
  try {
    for await (const event of streamGradeAnswer(input, userId)) {
      if (!event.verdict) {
        yield event;
        continue;
      }
      kept = event.verdict.ai?.status === 'ok';
      const quota = held ? (kept ? held.quota : await held.refund()) : null;
      yield { ...event, verdict: { ...event.verdict, ai: { ...(event.verdict.ai ?? OK), quota } } };
    }
  } finally {
    if (!kept) await held?.refund().catch(() => undefined);
  }
}

// --- rubric -------------------------------------------------------------------------------------------------------

/** Writes a draft rubric on the user's card. An approved rubric stays as it is. Model failure: nothing saved, unit given back. */
export async function attachRubric(userId: string, cardId: string) {
  if (!allow('rubric', userId, RUBRIC_PER_MINUTE)) return limited;
  return shared(`rubric:${userId}:${cardId}`, () => buildRubric(userId, cardId));
}

async function buildRubric(userId: string, cardId: string): Promise<{ ok: true; data: z.infer<typeof rubricSchema>; ai: AiInfo } | AiFailure> {
  const { db, cards, boards } = await dbm();
  const [card] = await db.select(pick(cards, 'id', 'boardId', 'deletedAt', 'rubric', 'source', 'title', 'back')).from(cards).where(eq(cards.id, cardId));
  if (!card || card.deletedAt) return { ok: false, error: { code: 'not_found', message: 'not found' } };
  const [board] = await db.select({ userId: boards.userId }).from(boards).where(eq(boards.id, card.boardId));
  if (!board || board.userId !== userId) return { ok: false, error: { code: 'not_found', message: 'not found' } };
  const existing = card.rubric && typeof card.rubric === 'object' ? card.rubric as { status?: string; inputHash?: string } : null;
  if (existing?.status === 'approved') return { ok: false, error: { code: 'conflict', message: 'approved rubric' } };
  const source = card.source?.trim() || AI_DRAFT_SOURCE;
  const hash = sha(`${card.title}\n${card.back ?? ''}\n${source}`);
  if (existing?.status === 'draft' && existing.inputHash === hash) {
    const parsed = rubricSchema.safeParse(existing);
    if (parsed.success) return { ok: true, data: parsed.data, ai: OK };
  }
  const remembered = cachedRubric(card.title, card.back, source);
  if (remembered) {
    await db.update(cards).set({ rubric: { ...remembered, inputHash: hash }, updatedAt: new Date() }).where(eq(cards.id, card.id));
    await invalidate('card.changed', { userId, mapId: card.boardId });
    return { ok: true, data: remembered, ai: OK };
  }
  const live = aiMode() === 'live';
  let held: Reservation | null = null;
  if (live) {
    const room = providerRoom();
    if (!room.ok) return room;
    if (process.env.DATABASE_URL) {
      const r = await reserveAi(userId, 'ai_rubrics');
      if (!r.ok) return { ok: false, error: r.error };
      held = r;
    }
  }
  let built: Awaited<ReturnType<typeof rubricWithMeta>>;
  try {
    built = await rubricWithMeta(card.title, card.back, source);
  } catch (e) {
    await held?.refund().catch(() => undefined);
    throw e;
  }
  const { rubric, meta } = built;
  const error = errorOf(meta);
  await recordCall(userId, 'rubric', { ...meta, promptVersion: RUBRIC_PROMPT_VERSION });
  if (live && error) {
    // G22 (D-1413): an offline rubric in place of the model's is not saved as if the AI wrote it; the student tries again.
    await held?.refund().catch(() => undefined);
    const failure = aiFailure(error);
    track('rubric', meta.model, meta.latencyMs, failure.ai!);
    return failure;
  }
  const info: AiInfo = live || aiMode() === 'mock' ? OK : failedInfo('fallback', 'not_configured', AI_ERROR_MESSAGES.not_configured);
  track('rubric', meta.model, meta.latencyMs, info);
  await db.update(cards).set({ rubric: { ...rubric, inputHash: hash }, updatedAt: new Date() }).where(eq(cards.id, card.id));
  await invalidate('card.changed', { userId, mapId: card.boardId });
  return { ok: true, data: rubric, ai: { ...info, quota: held?.quota ?? null } };
}

// --- "Essa correção está errada" ------------------------------------------------------------------------------------

/** G22 (D-1416): flags the user's own graded call. Under RLS (insert policy checks the call is theirs and a grade). Idempotent. */
export async function flagGrade(userId: string, callId: string) {
  return run(userId, async (tx) => {
    await tx.execute(sql`insert into ai_grade_flags (call_id, user_id) select id, user_id from ai_calls where id = ${callId} and kind = 'grade' on conflict (call_id) do nothing`);
    const [row] = await tx.execute<{ created_at: string }>(sql`select created_at from ai_grade_flags where call_id = ${callId}`);
    return row ? ok({ callId, flaggedAt: new Date(row.created_at).toISOString() }) : err('not_found', 'grade not found');
  });
}

// --- map generation jobs (D-1415): state in ai_jobs, run by Inngest or inline ---------------------------------------

/** D-532: what the PDF path decides about the map up front (items checked, password already hashed: no plaintext waits). */
type BoardExtras = { matrixItemIds: string[]; share: Awaited<ReturnType<typeof initialShareColumns>> };
type JobInput = { kind: 'text' | 'pdf'; title: string; area: GenerateBoardInput['area']; extras?: BoardExtras };
type JobStats = { cards?: number; edges?: number; pages?: number; dropped?: number; truncated?: boolean };

/** Characters of pasted text one generation accepts (env, D-1414); PDFs beyond it are cut by packages/ai (`truncated`). */
const maxInputChars = () => Number(process.env.AI_MAX_INPUT_CHARS) || 120_000;
/** Running in this process: cancel aborts the model call. Another process sees the cancel when it reads the job row. */
const running = new Map<string, AbortController>();

async function saveBoard(tx: Tx, userId: string, input: JobInput, cards: CardDraft[], edges: { fromRef: string; toRef: string; label: string | null }[]) {
  const { boards, boardMatrixItems, cards: cardTable, edges: edgeTable } = await dbm();
  const places = new Map(layout(cards, edges).map((p) => [p.ref, p]));
  const itemIds = input.extras?.matrixItemIds ?? [];
  const [board] = await tx.insert(boards).values({ userId, title: input.title, area: input.area, status: 'private', matrixItemId: itemIds[0] ?? null, ...input.extras?.share }).returning();
  if (itemIds.length) await tx.insert(boardMatrixItems).values(itemIds.map((matrixItemId) => ({ boardId: board!.id, matrixItemId })));
  // G21 FR-21 (D-1036): one insert of all cards (ids generated here, no `returning` round trip) and one of the edges (was ~1 per card/edge)
  const ids = new Map<string, string>();
  const rows = cards.filter((c) => c.type !== 'image').map((card, order) => {
    const place = places.get(card.ref);
    const id = crypto.randomUUID();
    ids.set(card.ref, id);
    return {
      id, boardId: board!.id, type: card.type, title: card.title, front: card.front, back: card.back, source: card.source ?? AI_DRAFT_SOURCE,
      payload: card.payload, status: 'draft' as const, order, x: place?.x ?? 80, y: place?.y ?? 80,
    };
  });
  if (rows.length) await tx.insert(cardTable).values(rows);
  const edgeRows = edges.flatMap((edge) => {
    const fromCardId = ids.get(edge.fromRef);
    const toCardId = ids.get(edge.toRef);
    return fromCardId && toCardId ? [{ boardId: board!.id, fromCardId, toCardId, label: edge.label }] : [];
  });
  if (edgeRows.length) await tx.insert(edgeTable).values(edgeRows);
  return board!.id;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * G22 (D-1414): an AI card stays only if its `sourceExcerpt` (12+ characters once normalized) is literally in the input text
 * (accents, case, punctuation and spacing ignored). packages/ai checks the same per chunk; this is the server's own check.
 */
export function sourcedCards<T extends { sourceExcerpt?: string }>(cards: T[], text: string): T[] {
  const haystack = fold(text);
  return cards.filter((c) => {
    const needle = fold(c.sourceExcerpt ?? '');
    return needle.length >= 12 && haystack.includes(needle);
  });
}

async function readableText(bytes: Uint8Array): Promise<string> {
  const literal = await readPdfText(bytes);
  return literal.length >= 40 ? literal : ocrPdf(bytes);
}

async function pdfSource(userId: string, assetId: string): Promise<string> {
  const { db, assets } = await dbm();
  const [asset] = await db.select({ userId: assets.userId, key: assets.key }).from(assets).where(eq(assets.id, assetId));
  if (!asset || asset.userId !== userId) throw new Error('pdf_not_found');
  const text = await readableText(await getBytes(asset.key));
  if (text.length < 40) throw new Error('pdf_unreadable');
  return text;
}

/**
 * Ends a queued/running job as failed and gives its unit back in the SAME statement (`charged` flips with the status), so a
 * reader that sees `failed` also sees the unit returned, and it is returned exactly once. A job that already has its board is left alone.
 */
async function failJob(jobId: string, code: string, ai: AiInfo = failedInfo('error', code, messageOf(code)), extra: { clearText?: boolean; userId?: string } = {}) {
  const { db } = await dbm();
  const [r] = await db.execute<{ id: string }>(sql`
    with old as (select id, user_id, charged, quota_period from ai_jobs
      where id = ${jobId} and status in ('queued', 'running') and board_id is null ${extra.userId ? sql`and user_id = ${extra.userId}` : sql``} for update),
    j as (update ai_jobs j set status = 'failed', progress = 100, stage = null, error = ${code}, ai = ${JSON.stringify(ai)}::jsonb, charged = false,
        text = ${extra.clearText ? null : sql`j.text`}, updated_at = now()
      from old where j.id = old.id
      returning old.id, old.user_id, old.charged, old.quota_period),
    back as (update usage_counters u set ai_generations = u.ai_generations - 1, updated_at = now()
      from j where j.charged and u.user_id = j.user_id and u.period = j.quota_period and u.ai_generations > 0 returning 1)
    select j.id, (select count(*) from back) as refunded from j`);
  if (!r) return false;
  if (code !== 'canceled') logFailed(jobId, code);
  return true;
}

async function setProgress(jobId: string, progress: number, stage: 'ocr' | 'extract' | 'layout') {
  const { db } = await dbm();
  await db.execute(sql`update ai_jobs set progress = greatest(progress, ${progress}), stage = ${stage}, updated_at = now() where id = ${jobId} and status = 'running'`);
}

async function dispatch(jobId: string) {
  const sent = await dispatchBoardJob(jobId).catch(() => false);
  if (!sent) void executeGeneration(jobId);
}

/** A queued/running job of the same user with the same input: the second start returns it (no second charge). */
async function activeJob(userId: string, hash: string) {
  const { db } = await dbm();
  const [r] = await db.execute<{ id: string }>(sql`select id from ai_jobs where user_id = ${userId} and input_hash = ${hash} and status in ('queued', 'running') limit 1`);
  return r?.id ?? null;
}

/** Checks shared by text and PDF: rate limit, map cap, AI configured, app AI limit, card room. Nothing is charged yet. */
async function preflight(userId: string): Promise<{ ok: true } | AiFailure> {
  if (!allow('generate', userId, GENERATE_PER_MINUTE)) return limited;
  const room = await boardRoom(userId);
  if (!room.ok) return room;
  if (aiMode() === 'off') return aiOff;
  const provider = providerRoom();
  if (!provider.ok) return provider;
  if ((await cardRoom(userId)) === 0) return { ok: false, error: { code: 'quota_exceeded', message: 'cards' } };
  return { ok: true };
}

type Started = { ok: true; data: { jobId: string; ai: AiInfo } } | AiFailure;

/** Reserves one ai_generations unit and writes the job; the caller dispatches it. */
async function createJob(userId: string, input: JobInput, hash: string, text: string | null, stats: JobStats, ocr: boolean): Promise<Started> {
  const existing = await activeJob(userId, hash);
  if (existing) return { ok: true, data: { jobId: existing, ai: OK } };
  const held = await reserveAi(userId, 'ai_generations');
  if (!held.ok) return { ok: false, error: held.error };
  const { db, aiJobs } = await dbm();
  try {
    const [job] = await db.insert(aiJobs).values({
      userId, kind: input.kind, input, text, inputHash: hash, stats, charged: true, quotaPeriod: held.quota.period,
      status: ocr ? 'running' : 'queued', stage: ocr ? 'ocr' : 'extract', progress: ocr ? 10 : 0,
    }).returning({ id: aiJobs.id });
    return { ok: true, data: { jobId: job!.id, ai: { ...OK, quota: held.quota } } };
  } catch (e) {
    await held.refund().catch(() => undefined);
    throw e;
  }
}

export async function startGeneration(userId: string, input: GenerateBoardInput): Promise<Started> {
  const pre = await preflight(userId);
  if (!pre.ok) return pre;
  if (input.kind === 'text' && input.text.length > maxInputChars()) return { ok: false, error: { code: 'validation', message: 'text_too_long' } };
  let text: string;
  try {
    text = input.kind === 'text' ? input.text : await pdfSource(userId, input.pdfAssetId);
  } catch (e) {
    return { ok: false, error: { code: 'validation', message: e instanceof Error ? e.message : 'failed' } };
  }
  const hash = sha(JSON.stringify([input.kind, input.title, input.area, text]));
  return shared(`gen:${userId}:${hash}`, async () => {
    const started = await createJob(userId, { kind: input.kind, title: input.title, area: input.area }, hash, text, {}, false);
    if (started.ok) await dispatch(started.data.jobId);
    return started;
  });
}

/**
 * Starts the PDF job and returns once rate limit, board cap and the monthly generation are cleared, before OCR spends anything.
 * OCR runs in this process (the bytes are not stored); the extraction is the same job as the text path. An unreadable PDF gives the unit back.
 */
export async function startPdfGeneration(userId: string, board: z.output<typeof generatePdfBoardInputSchema>, bytes: Uint8Array): Promise<Started> {
  const pre = await preflight(userId);
  if (!pre.ok) return pre;
  // D-532: items must be leaves of the board's area (same rule as createBoard/import), checked before anything is charged.
  if (board.matrixItemIds.length) {
    const { db, matrixItems } = await dbm();
    const valid = await db.select({ id: matrixItems.id }).from(matrixItems).where(and(inArray(matrixItems.id, board.matrixItemIds), eq(matrixItems.area, board.area),
      sql`not exists (select 1 from matrix_items c where c.parent_id = ${matrixItems.id})`));
    if (valid.length !== board.matrixItemIds.length) return { ok: false, error: { code: 'validation', message: 'matrixItemId is unknown, a group, or does not belong to the board area' } };
  }
  const input: JobInput = { kind: 'pdf', title: board.title, area: board.area, extras: { matrixItemIds: board.matrixItemIds, share: await initialShareColumns({ access: board.access, password: board.password }) } };
  const hash = sha(Buffer.concat([Buffer.from(JSON.stringify([board.title, board.area])), Buffer.from(bytes)]));
  return shared(`gen:${userId}:${hash}`, async () => {
    const started = await createJob(userId, input, hash, null, { pages: pdfPageCount(bytes) }, true);
    if (started.ok) void readPdfJob(started.data.jobId, bytes);
    return started;
  });
}

async function readPdfJob(jobId: string, bytes: Uint8Array) {
  let text: string;
  try {
    text = await readableText(bytes);
  } catch {
    text = '';
  }
  if (text.length < 40) {
    await failJob(jobId, 'pdf_unreadable');
    return;
  }
  const { db } = await dbm();
  const [moved] = await db.execute<{ id: string }>(sql`
    update ai_jobs set text = ${text}, status = 'queued', stage = 'extract', progress = 20, updated_at = now() where id = ${jobId} and status = 'running' returning id`);
  if (moved) await dispatch(jobId); // canceled while reading: nothing to do
}

/** Inngest function body and inline runner. Claims the job (queued -> running) so only one process ever runs it. */
export async function runGeneration(jobId: string) {
  await executeGeneration(jobId);
}

class JobError extends Error {
  constructor(readonly code: string, readonly info?: AiInfo) {
    super(code);
  }
}

async function executeGeneration(jobId: string) {
  const { db, aiJobs } = await dbm();
  const [job] = await db.update(aiJobs)
    .set({ status: 'running', progress: sql`greatest(${aiJobs.progress}, 30)`, stage: 'extract', attempts: sql`${aiJobs.attempts} + 1`, updatedAt: new Date() })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.status, 'queued')))
    .returning();
  if (!job) return;
  const input = job.input as JobInput;
  const text = job.text ?? '';
  const ac = new AbortController();
  running.set(jobId, ac);
  const cancellable: typeof fetch = (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal });
  const startedAt = Date.now(); // ponytail: run time only (queue wait not counted); map_ready decides the e-mail from it
  let model = 'none';
  let latencyMs = 0;
  try {
    const room = await cardRoom(job.userId);
    if (room === 0) throw new JobError('cards');
    const live = aiMode() === 'live';
    const { extracted, meta } = await extractWithMeta(text, AI_DRAFT_SOURCE, cancellable, undefined, room ?? undefined);
    if (ac.signal.aborted) return; // canceled: the cancel already ended the job and gave the unit back
    model = meta.model;
    latencyMs = meta.latencyMs;
    const error = errorOf(meta);
    // D-1414: a model failure is a failed job (unit given back, retry available), never a paragraph split saved as an AI map
    if (live && error) throw new JobError(error.code, failedInfo('error', error.code, error.userMessage));
    const all = extracted.cards as (CardDraft & { sourceExcerpt?: string })[];
    const kept = (live ? sourcedCards(all, text) : all.map((c) => ({ ...c, source: OFFLINE_DRAFT_SOURCE }))).slice(0, room ?? Infinity);
    if (!kept.length) throw new JobError('no_sourced_cards');
    const refs = new Set(kept.map((c) => c.ref));
    const edges = extracted.edges.filter((e) => refs.has(e.fromRef) && refs.has(e.toRef));
    const stats: JobStats = { ...(job.stats as JobStats | null), cards: kept.length, edges: edges.length, dropped: all.length - kept.length + (meta.dropped ?? 0), ...(meta.truncated ? { truncated: true } : {}) };
    await setProgress(jobId, 75, 'layout');
    if (!(await boardRoom(job.userId)).ok) throw new JobError('boards'); // a concurrent map took the last slot: refund below
    const ai: AiInfo = live ? OK : failedInfo('fallback', 'offline', 'Mapa montado sem IA (modo de teste).');
    // Board + board_id in one transaction holding the job row: a cancel lands before (nothing saved) or after (a job with a board
    // is never failed or canceled, see failJob). `done` comes after the side effects, so done = map, referral and cost row all there.
    const boardId = await db.transaction(async (tx) => {
      const [row] = await tx.execute<{ status: string }>(sql`select status from ai_jobs where id = ${jobId} for update`);
      if (row?.status !== 'running') return null;
      const id = await saveBoard(tx, job.userId, input, kept, edges);
      await tx.update(aiJobs).set({ progress: 95, boardId: id, text: null, error: null, ai, stats, updatedAt: new Date() }).where(eq(aiJobs.id, jobId));
      return id;
    });
    if (!boardId) return;
    try {
      await invalidate('map.changed', { userId: job.userId, mapId: boardId }); // after the commit: the generated map and its draft cards
      await maybeQualifyReferral(job.userId); // F18 (D-485): after the writes; never throws. Draft cards count (D-402 does not filter status)
      await recordCall(job.userId, job.kind === 'pdf' ? 'generate_pdf' : 'generate_text', { ...meta, promptVersion: EXTRACT_PROMPT_VERSION });
    } finally {
      await db.update(aiJobs).set({ status: 'done', progress: 100, stage: null, updatedAt: new Date() }).where(eq(aiJobs.id, jobId));
    }
    track('extract', model, latencyMs, ai, jobId);
    await notifyMapReady({ userId: job.userId, boardId, origin: job.kind === 'pdf' ? 'pdf' : 'text', tookMs: Date.now() - startedAt }); // G18; never throws
  } catch (e) {
    const code = e instanceof JobError ? e.code : e instanceof Error ? e.message : 'failed';
    const ai = e instanceof JobError && e.info ? e.info : failedInfo('error', code, messageOf(code));
    await failJob(jobId, code, ai).catch(() => undefined);
    track('extract', model, latencyMs, ai, jobId);
  } finally {
    running.delete(jobId);
  }
}

/** POST /v1/ai/jobs/:id/cancel. Queued/running only; the unit goes back and the input text is erased. */
export async function cancelGeneration(userId: string, jobId: string): Promise<{ ok: true } | AiFailure> {
  const canceled = await failJob(jobId, 'canceled', failedInfo('error', 'canceled', JOB_MESSAGES.canceled!), { clearText: true, userId });
  if (!canceled) return (await generationOf(userId, jobId)) ? { ok: false, error: { code: 'conflict', message: 'job is not running' } } : { ok: false, error: { code: 'not_found', message: 'job not found' } };
  running.get(jobId)?.abort();
  if (inngestConfigured()) await inngest.send({ name: 'ai/board.cancel', data: { jobId } }).catch(() => undefined);
  return { ok: true };
}

/** POST /v1/ai/jobs/:id/retry. A failed job that still has its text runs again with a new unit (the failure gave the old one back). */
export async function retryGeneration(userId: string, jobId: string): Promise<Started> {
  if (!allow('generate', userId, GENERATE_PER_MINUTE)) return limited;
  if (aiMode() === 'off') return aiOff;
  const provider = providerRoom();
  if (!provider.ok) return provider;
  const job = await generationOf(userId, jobId);
  if (!job) return { ok: false, error: { code: 'not_found', message: 'job not found' } };
  if (job.status !== 'failed' || job.error === 'canceled') return { ok: false, error: { code: 'conflict', message: 'job cannot be retried' } };
  const held = await reserveAi(userId, 'ai_generations');
  if (!held.ok) return { ok: false, error: held.error };
  const { db } = await dbm();
  const [moved] = await db.execute<{ id: string }>(sql`
    update ai_jobs set status = 'queued', stage = 'extract', progress = 20, error = null, ai = null, board_id = null, charged = true,
      quota_period = ${held.quota.period}::date, updated_at = now()
    where id = ${jobId} and user_id = ${userId} and status = 'failed' and text is not null returning id`);
  if (!moved) {
    await held.refund().catch(() => undefined);
    return { ok: false, error: { code: 'conflict', message: 'job cannot be retried' } };
  }
  await dispatch(jobId);
  return { ok: true, data: { jobId, ai: { ...OK, quota: held.quota } } };
}

export type GenerationView = BoardGenerationProgress;

/** GET /v1/ai/jobs/:id from the database, under RLS (any process, after a restart too). */
export async function generationOf(userId: string, jobId: string): Promise<GenerationView | null> {
  return run(userId, async (tx, s) => {
    const [j] = await tx.select(pick(s.aiJobs, 'id', 'status', 'progress', 'stage', 'boardId', 'error', 'ai', 'stats')).from(s.aiJobs).where(eq(s.aiJobs.id, jobId));
    if (!j) return null;
    const stats = (j.stats ?? {}) as JobStats;
    return {
      jobId: j.id, status: j.status, progress: j.progress, stage: j.stage as GenerationView['stage'], boardId: j.boardId, error: j.error,
      ai: (j.ai as AiInfo | null) ?? null,
      ...(stats.cards !== undefined ? { cards: stats.cards } : {}), ...(stats.edges !== undefined ? { edges: stats.edges } : {}),
      ...(stats.pages !== undefined ? { pages: stats.pages } : {}), ...(stats.dropped !== undefined ? { dropped: stats.dropped } : {}),
    };
  });
}

export type { AiQuota };
