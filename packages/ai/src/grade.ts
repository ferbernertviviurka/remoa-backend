import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubricSchema, type GraderInput, type GraderVerdict, type Rubric } from '@remoa/contracts';
import { gradeOffline } from './offline';
import { GRADER_PROMPT_VERSION, completeJSON, feedbackSoFar, graderModel, rubricModel, graderUser, parseVerdict, streamJSON } from './openrouter';

const dir = dirname(fileURLToPath(import.meta.url));
const graderPrompt = readFileSync(join(dir, '../prompts/grader/v1.md'), 'utf8');
const rubricPrompt = readFileSync(join(dir, '../prompts/rubric/v1.md'), 'utf8');

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
  if (!process.env.OPENROUTER_API_KEY) {
    for (const event of offline()) yield event;
    return;
  }
  let acc = '';
  let shown = '';
  let model = graderModel();
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    for await (const part of streamJSON({ model: graderModel(), system: graderPrompt, user: graderUser(input), timeoutMs: 8_000, fetchImpl })) {
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
  if (!process.env.OPENROUTER_API_KEY) {
    return { verdict: gradeOffline(input), meta: { promptVersion: GRADER_PROMPT_VERSION, tokensIn: 0, tokensOut: 0, latencyMs: Date.now() - started } };
  }
  try {
    const done = await completeJSON({ model: graderModel(), system: graderPrompt, user: graderUser(input), timeoutMs: 8_000, fetchImpl });
    const verdict = parseVerdict(done.text, done.model);
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

/** OpenRouter when the key exists; the cached offline rubric otherwise, or if the model reply is invalid. */
export async function rubricWithMeta(title: string, back: string | null, source: string, fetchImpl?: typeof fetch): Promise<Rubric> {
  if (!process.env.OPENROUTER_API_KEY) return rubricFromCard(title, back, source);
  try {
    const done = await completeJSON({
      model: rubricModel(),
      system: rubricPrompt,
      user: JSON.stringify({ title, back, source }),
      fetchImpl,
    });
    const raw = JSON.parse(done.text) as Record<string, unknown>;
    const parsed = rubricSchema.safeParse({ ...raw, source, version: raw.version ?? 1, status: 'draft', reviewerId: null });
    if (!parsed.success) return rubricFromCard(title, back, source);
    rubricCache.set(`${source}\n${title}\n${back ?? ''}`, parsed.data);
    return parsed.data;
  } catch {
    return rubricFromCard(title, back, source);
  }
}

export const costCents = (tokensIn: number, tokensOut: number) => Math.round((tokensIn * 0.00008 + tokensOut * 0.0004) * 100);
