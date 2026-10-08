// G25 (F32): challenge limits and per-task models, read from `.env` on every call (same pattern as aiConfig).
import { z } from 'zod';
import { chainFor, modelFor } from './config';

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
const int = (def: number, min: number) => z.coerce.number().int().min(min).optional().transform((v) => v ?? def);

const schema = z.object({
  CHALLENGE_SESSION_TTL_MIN: int(120, 1),
  CHALLENGE_MAX_GRADINGS_PER_CARD_HOUR: int(5, 1),
  CHALLENGE_MAX_GRADINGS_PER_CARD_DAY: int(5, 1),
  CHALLENGE_BATCH_GRADE_MAX: int(10, 1),
  GEN_BATCH_SIZE: int(10, 1),
  GEN_DUP_THRESHOLD: z.coerce.number().gt(0).max(1).optional().transform((v) => v ?? 0.8),
  ANSWER_MAX_CHARS: int(1200, 1),
});

export type ChallengeLimits = {
  sessionTtlMin: number;
  maxGradingsPerCardHour: number;
  maxGradingsPerCardDay: number;
  batchGradeMax: number;
  genBatchSize: number;
  dupThreshold: number;
  answerMaxChars: number;
};

/** Throws on a malformed value (e.g. GEN_DUP_THRESHOLD=2), never on a missing or empty one. */
export function challengeLimits(env: NodeJS.ProcessEnv = process.env): ChallengeLimits {
  const p = schema.parse(Object.fromEntries(Object.keys(schema.shape).map((k) => [k, blank(env[k])])));
  return {
    sessionTtlMin: p.CHALLENGE_SESSION_TTL_MIN,
    maxGradingsPerCardHour: p.CHALLENGE_MAX_GRADINGS_PER_CARD_HOUR,
    maxGradingsPerCardDay: p.CHALLENGE_MAX_GRADINGS_PER_CARD_DAY,
    batchGradeMax: p.CHALLENGE_BATCH_GRADE_MAX,
    genBatchSize: p.GEN_BATCH_SIZE,
    dupThreshold: p.GEN_DUP_THRESHOLD,
    answerMaxChars: p.ANSWER_MAX_CHARS,
  };
}

/** AI_MODEL_GRADE, AI_MODEL_GENERATE, AI_MODEL_SUMMARY; empty falls back to AI_MODEL. Separate from the legacy `grader` (AI_MODEL_GRADER). */
export const CHALLENGE_TASKS = ['grade', 'generate', 'summary'] as const;
export type ChallengeTask = (typeof CHALLENGE_TASKS)[number];

export const challengeModelFor = (task: ChallengeTask, env: NodeJS.ProcessEnv = process.env) => modelFor(task, env);
export const challengeChainFor = (task: ChallengeTask, env: NodeJS.ProcessEnv = process.env) => chainFor(task, env);
