import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { graderVerdictSchema, rubricSchema, type GraderInput, type GraderVerdict, type Rubric } from '@remoa/contracts';
import { gradeOffline } from './offline';
import { AiError, generateJson, streamText, type Tool } from './client';
import { aiMode } from './config';
import { GRADER_PROMPT_VERSION, feedbackSoFar, graderUser, parseVerdict } from './openrouter';

const dir = dirname(fileURLToPath(import.meta.url));
const graderPrompt = readFileSync(join(dir, '../prompts/grader/v2.md'), 'utf8');
const rubricPrompt = readFileSync(join(dir, '../prompts/rubric/v1.md'), 'utf8');

/** Whole budget of one grade or rubric call (all retries and fallbacks); the challenge also cuts at 8 s (GRADER_TIMEOUT_MS). */
const GRADE_BUDGET_MS = 8_000;

const gradeTool: Tool = {
  type: 'function',
  function: {
    name: 'grade',
    description: 'Veredito da resposta somente contra a rubrica.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
        matched: { type: 'array', items: { type: 'string' } },
        missing: { type: 'array', items: { type: 'string' } },
        criticalError: { type: 'boolean' },
        feedback: { type: 'string' },
      },
      required: ['verdict', 'matched', 'missing', 'criticalError', 'feedback'],
    },
  },
};

/** Same contract as `parseVerdict`: the model's `costCents` is dropped and `model` defaults to the one that answered. */
const verdictReply = graderVerdictSchema.omit({ model: true, costCents: true }).extend({ model: z.string().min(1).optional() });

const graderCall = (input: GraderInput, fetchImpl?: typeof fetch) => ({
  fn: 'grader', system: graderPrompt, user: graderUser(input), tool: gradeTool, fetchImpl, signal: AbortSignal.timeout(GRADE_BUDGET_MS),
});

export type GradeMeta = { promptVersion: string; tokensIn: number; tokensOut: number; latencyMs: number };

export type GradeEvent = { feedback?: string; verdict?: GraderVerdict; meta?: GradeMeta };

/** Streams feedback as the model writes it. Without a key, or if the reply is invalid, the local rubric grader is chunked instead. */
export async function* streamGrade(input: GraderInput, fetchImpl?: typeof fetch): AsyncGenerator<GradeEvent> {
  const started = Date.now();
  const offline = (): GradeEvent[] => {
    const verdict = gradeOffline(input);
    const pieces = verdict.feedback.split(/(?<=\s)/).filter(Boolean);
    return [...pieces.map((feedback) => ({ feedback })), { verdict, meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } }];
  };
  if (aiMode() !== 'live') {
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
    const verdict = parseVerdict(acc, model);
    yield { verdict, meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn, tokensOut, latencyMs: Date.now() - started } };
  } catch {
    if (shown) {
      yield { verdict: gradeOffline(input), meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } };
      return;
    }
    for (const event of offline()) yield event;
  }
}

export async function gradeWithMeta(input: GraderInput, fetchImpl?: typeof fetch): Promise<{ verdict: GraderVerdict; meta: GradeMeta }> {
  const started = Date.now();
  if (aiMode() !== 'live') {
    return { verdict: gradeOffline(input), meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } };
  }
  try {
    const done = await generateJson(verdictReply, graderCall(input, fetchImpl));
    const verdict: GraderVerdict = { ...done.data, model: done.data.model ?? done.model };
    return { verdict, meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: done.tokensIn, tokensOut: done.tokensOut, latencyMs: Date.now() - started } };
  } catch {
    return { verdict: gradeOffline(input), meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } };
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

export type RubricMeta = { model: string; tokensIn: number; tokensOut: number; latencyMs: number };

/** The model's rubric with the server-owned fields forced (source, draft status, no reviewer). */
const rubricReply = (source: string) =>
  z.record(z.unknown()).transform((raw) => ({ ...raw, source, version: raw.version ?? 1, status: 'draft' as const, reviewerId: null })).pipe(rubricSchema);

/** OpenRouter when configured; the cached offline rubric otherwise, or if the model reply stays invalid after one repair. */
export async function rubricWithMeta(title: string, back: string | null, source: string, fetchImpl?: typeof fetch): Promise<{ rubric: Rubric; meta: RubricMeta }> {
  const offline = (meta: RubricMeta = { model: 'offline-rubric', tokensIn: 0, tokensOut: 0, latencyMs: 0 }) => ({ rubric: rubricFromCard(title, back, source), meta });
  if (aiMode() !== 'live') return offline();
  try {
    const done = await generateJson(rubricReply(source), {
      fn: 'rubric', system: rubricPrompt, user: JSON.stringify({ title, back, source }), fetchImpl, signal: AbortSignal.timeout(GRADE_BUDGET_MS),
    });
    rubricCache.set(`${source}\n${title}\n${back ?? ''}`, done.data);
    return { rubric: done.data, meta: { model: done.model, tokensIn: done.tokensIn, tokensOut: done.tokensOut, latencyMs: done.latencyMs } };
  } catch (e) {
    return offline(e instanceof AiError && e.usage ? e.usage : undefined);
  }
}
