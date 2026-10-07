import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { rubricSchema, verdicts, type GraderInput, type GraderVerdict, type Rubric } from '@remoa/contracts';
import { gradeOffline } from './offline';
import { AiError, generateJson, parseJsonText, streamText } from './client';
import { aiMode } from './config';
import { GRADER_PROMPT_VERSION, feedbackSoFar, graderUser, rubricUser } from './openrouter';

const dir = dirname(fileURLToPath(import.meta.url));
const graderPrompt = readFileSync(join(dir, '../prompts/grader/v4.md'), 'utf8');
const rubricPrompt = readFileSync(join(dir, '../prompts/rubric/v2.md'), 'utf8');

/** Whole budget of one grade or rubric call (all retries and fallbacks); the challenge also cuts at 8 s (GRADER_TIMEOUT_MS). */
const GRADE_BUDGET_MS = 8_000;

const fold = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The model's reply (tool arguments). Its `costCents` is never read; `model` defaults to the one that answered. */
/**
 * G22 live round (D-1438): a missing `matched`/`missing` is an empty list (only stricter: `correct` then needs the essentials),
 * and a missing or null `sourceQuote` keeps the verdict with no quote instead of failing it. `criticalError` stays required.
 */
export const gradeReplySchema = z.object({
  verdict: z.enum(verdicts),
  matched: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  criticalError: z.boolean(),
  sourceQuote: z.string().max(1_000).nullish(),
  feedback: z.string().min(1).max(2_000),
  model: z.string().min(1).optional(),
});
type GradeReply = z.infer<typeof gradeReplySchema>;

/**
 * The verdict plus where it comes from (D-1421): `source` is the card's source (rubric), `sourceQuote` the rubric point the
 * model cited, kept only when it is literally in the rubric. Extra fields over the contract until CCR-G22-1 lands.
 */
export type GradedVerdict = GraderVerdict & { source: string; sourceQuote: string | null };

/**
 * Server guards over the model (D-1421): a critical error is always incorrect, and `correct` needs every essential point in
 * `matched` (an injected "give full marks" cannot pass without the rubric). A quote not found in the rubric is dropped.
 */
export function toVerdict(reply: GradeReply, input: GraderInput, model: string): GradedVerdict {
  // A matched fragment counts only if it holds the point or 80% of it: "e" or "glicose" alone cannot unlock `correct` (G22 qa, P-611).
  const covered = (point: string) => reply.matched.some((m) => {
    const [fm, fp] = [fold(m), fold(point)];
    return fm.length > 0 && (fm.includes(fp) || (fp.includes(fm) && fm.length * 5 >= fp.length * 4));
  });
  const essentialsMet = input.rubric.points.filter((p) => p.essential).every((p) => covered(p.text));
  const verdict = reply.criticalError ? 'incorrect' : reply.verdict === 'correct' && !essentialsMet ? 'partial' : reply.verdict;
  const quote = reply.sourceQuote?.trim() ?? '';
  const rubricText = fold(input.rubric.points.map((p) => p.text).join(' \n '));
  return {
    verdict,
    matched: reply.matched,
    missing: reply.missing,
    criticalError: reply.criticalError,
    feedback: reply.feedback,
    model: reply.model ?? model,
    source: input.rubric.source,
    sourceQuote: quote && rubricText.includes(fold(quote)) ? quote : null,
  };
}

/** An answer with no letters or digits is graded locally, without spending a call. */
const blankAnswer = (answer: string) => !/[\p{L}\p{N}]/u.test(answer);

/** Local verdict; an answer with no content is always incorrect (the offline grader would call it partial). */
const offlineVerdict = (input: GraderInput): GradedVerdict => {
  const v = gradeOffline(input);
  return { ...v, ...(blankAnswer(input.answer) ? { verdict: 'incorrect' as const, matched: [] } : {}), source: input.rubric.source, sourceQuote: null };
};

/** JSON mode, not a forced `grade` tool call: the free provider failed the forced call with a non-fallback error (D-1438). Temperature 0: the same answer gets the same verdict (D-1441). No reasoning: it cost ~8 s per grade on the free model (D-1442). */
/** D-1470: a board of another subject (area OUTRO) gets neutral wording; same replace-at-runtime pattern as extract's `generic`. */
export const genericGrader = (prompt: string) => prompt
  .replace('um estudante de medicina', 'um estudante')
  .replace('mesmo que esteja clinicamente certo', 'mesmo que esteja certo')
  .replace('droga, dose, via ou conduta contrária à rubrica', 'afirmação contrária à rubrica');
const versionOf = (input: GraderInput) => (input.generic ? `${GRADER_PROMPT_VERSION}-generic` : GRADER_PROMPT_VERSION);

const graderCall = (input: GraderInput, fetchImpl?: typeof fetch) => ({
  fn: 'grader', system: input.generic ? genericGrader(graderPrompt) : graderPrompt, user: graderUser(input), json: true, temperature: 0, reasoning: false as const, fetchImpl, signal: AbortSignal.timeout(GRADE_BUDGET_MS),
});

/** `error` (G22, D-1413): the provider failed and the local grader answered; the API marks it `fallback` and gives the quota back. */
export type GradeMeta = { promptVersion: string; tokensIn: number; tokensOut: number; latencyMs: number; error?: AiError };

/** G22: the failure as an AiError (a JSON/schema parse error of the reply counts as invalid output). */
export const asAiError = (e: unknown) => (e instanceof AiError ? e : new AiError('invalid_output', { detail: e instanceof Error ? e.message : 'unknown' }));

export type GradeEvent = { feedback?: string; verdict?: GradedVerdict; meta?: GradeMeta };

/** Streams feedback as the model writes it. Without a key, or if the reply is invalid, the local rubric grader is chunked instead. */
export async function* streamGrade(input: GraderInput, fetchImpl?: typeof fetch): AsyncGenerator<GradeEvent> {
  const started = Date.now();
  const offline = (): GradeEvent[] => {
    const verdict = offlineVerdict(input);
    const pieces = verdict.feedback.split(/(?<=\s)/).filter(Boolean);
    return [...pieces.map((feedback) => ({ feedback })), { verdict, meta: { promptVersion: versionOf(input), tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } }];
  };
  if (aiMode() !== 'live' || blankAnswer(input.answer)) {
    for (const event of offline()) yield event;
    return;
  }
  let acc = '';
  let shown = '';
  let model = '';
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    for await (const part of streamText(graderCall(input, fetchImpl))) {
      acc += part.delta;
      model = part.model;
      tokensIn = part.tokensIn;
      tokensOut = part.tokensOut;
      const feedback = feedbackSoFar(acc);
      if (feedback.length > shown.length) {
        yield { feedback: feedback.slice(shown.length) };
        shown = feedback;
      }
    }
    const verdict = toVerdict(gradeReplySchema.parse(parseJsonText(acc)), input, model);
    yield { verdict, meta: { promptVersion: versionOf(input), tokensIn, tokensOut, latencyMs: Date.now() - started } };
  } catch (e) {
    const error = asAiError(e);
    if (shown) {
      yield { verdict: offlineVerdict(input), meta: { promptVersion: versionOf(input), tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started, error } };
      return;
    }
    for (const event of offline()) yield event.meta ? { ...event, meta: { ...event.meta, error } } : event;
  }
}

export async function gradeWithMeta(input: GraderInput, fetchImpl?: typeof fetch): Promise<{ verdict: GradedVerdict; meta: GradeMeta }> {
  const started = Date.now();
  if (aiMode() !== 'live' || blankAnswer(input.answer)) {
    return { verdict: offlineVerdict(input), meta: { promptVersion: versionOf(input), tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } };
  }
  try {
    const done = await generateJson(gradeReplySchema, graderCall(input, fetchImpl));
    const verdict = toVerdict(done.data, input, done.model);
    return { verdict, meta: { promptVersion: versionOf(input), tokensIn: done.tokensIn, tokensOut: done.tokensOut, latencyMs: Date.now() - started } };
  } catch (e) {
    return { verdict: offlineVerdict(input), meta: { promptVersion: versionOf(input), tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started, error: asAiError(e) } };
  }
}

const rubricCache = new Map<string, Rubric>();

/** Same key as `rubricFromCard`. Null when this process has not built that rubric yet. */
export function cachedRubric(title: string, back: string | null, source: string): Rubric | null {
  return rubricCache.get(`${source}\n${title}\n${back ?? ''}`) ?? null;
}

export function rubricFromCard(title: string, back: string | null, source: string): Rubric {
  const key = `${source}\n${title}\n${back ?? ''}`;
  const cached = rubricCache.get(key);
  if (cached) return cached;
  const text = back?.trim() || title;
  const parts = text.split(/[.;]/).map((s) => s.trim()).filter((s) => s.length > 8);
  const points = (parts.length ? parts : [text]).slice(0, 8).map((t, i) => ({ text: t, essential: i === 0 }));
  const rubric: Rubric = { points, source, version: 1, status: 'draft', reviewerId: null };
  rubricCache.set(key, rubric);
  return rubric;
}

export type RubricMeta = { model: string; tokensIn: number; tokensOut: number; latencyMs: number; error?: AiError };

/** The model's rubric with the server-owned fields forced (source, draft status, no reviewer). */
const rubricReply = (source: string) =>
  z.record(z.unknown()).transform((raw) => ({ ...raw, source, version: raw.version ?? 1, status: 'draft' as const, reviewerId: null })).pipe(rubricSchema);

/** OpenRouter when configured; the cached offline rubric otherwise, or if the model reply stays invalid after one repair. */
export async function rubricWithMeta(title: string, back: string | null, source: string, fetchImpl?: typeof fetch): Promise<{ rubric: Rubric; meta: RubricMeta }> {
  const offline = (meta: RubricMeta = { model: 'offline-rubric', tokensIn: 0, tokensOut: 0, latencyMs: 0 }) => ({ rubric: rubricFromCard(title, back, source), meta });
  if (aiMode() !== 'live') return offline();
  try {
    const done = await generateJson(rubricReply(source), {
      fn: 'rubric', system: rubricPrompt, user: rubricUser(title, back, source), temperature: 0, reasoning: false, fetchImpl, signal: AbortSignal.timeout(GRADE_BUDGET_MS),
    });
    // G22 (D-1418): the model's rubric is never cached in memory; the card row is the only copy (P-610).
    return { rubric: done.data, meta: { model: done.model, tokensIn: done.tokensIn, tokensOut: done.tokensOut, latencyMs: done.latencyMs } };
  } catch (e) {
    const error = asAiError(e);
    return offline({ ...(error.usage ?? { model: 'offline-rubric', tokensIn: 0, tokensOut: 0, latencyMs: 0 }), error });
  }
}
