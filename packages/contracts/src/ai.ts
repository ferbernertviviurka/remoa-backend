import { z } from 'zod';
import { areas, jobStatuses, verdicts } from './enums';
import { idSchema, timestampSchema } from './common';
import { rubricSchema } from './card';

/** Stored as the card source until a person reviews an AI draft (F05). */
export const AI_DRAFT_SOURCE = 'Gerado por IA, não revisado';
/** G22 (D-1414): cards cut from the text without a model (AI=mock only); never labelled as AI. */
export const OFFLINE_DRAFT_SOURCE = 'Dividido do texto sem IA, não revisado';

// --- G22 (CCR-070): what happened with the AI, on every AI response -----------------------------------------------
/** ok = the model answered; fallback = the local grader answered instead (marked, quota given back); error = nothing usable. */
export const aiStatuses = ['ok', 'fallback', 'error'] as const;
export type AiStatus = (typeof aiStatuses)[number];
/** Metered AI counters. ai_rubrics has its own counter with the ai_grades number of the plan (D-1412). */
export const aiQuotaKeys = ['ai_grades', 'ai_rubrics', 'ai_generations'] as const;
export const aiQuotaSchema = z.object({
  key: z.enum(aiQuotaKeys),
  used: z.number().int().nonnegative(),
  /** null = unlimited. */
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  /** used >= 80% of limit: show the "perto do limite" notice. */
  nearLimit: z.boolean(),
  /** Local day (YYYY-MM-DD, profile timezone, midnight rollover) or first day of the month for ai_generations. */
  period: z.string(),
});
export type AiQuota = z.infer<typeof aiQuotaSchema>;
export const aiInfoSchema = z.object({
  status: z.enum(aiStatuses),
  /** packages/ai AiErrorCode (timeout, rate_limited, provider_error, invalid_output, ...) or `offline`; null when ok. */
  code: z.string().nullable(),
  /** pt-BR message safe to show; null when ok. */
  message: z.string().nullable(),
  /** ai_calls id of a correction: POST /v1/ai/grades/:id/flag. */
  callId: idSchema.nullable().optional(),
  quota: aiQuotaSchema.nullable().optional(),
});
export type AiInfo = z.infer<typeof aiInfoSchema>;
/** POST /v1/ai/grades/:callId/flag ("Essa correção está errada"). No body: the answer text is never stored. Idempotent. */
export const aiGradeFlagSchema = z.object({ callId: idSchema, flaggedAt: timestampSchema });
export type AiGradeFlag = z.infer<typeof aiGradeFlagSchema>;

export const graderInputSchema = z.object({
  prompt: z.string().min(1),
  canonical: z.string().min(1),
  rubric: rubricSchema,
  /** Neighbour cards/labels as plain text context. */
  neighbors: z.array(z.string()),
  answer: z.string().min(1).max(4000),
  /** CCR-083 (D-1470): the card's board area is OUTRO, so the grader drops the medical persona. */
  generic: z.boolean().optional(),
});
export type GraderInput = z.infer<typeof graderInputSchema>;

export const graderVerdictSchema = z.object({
  verdict: z.enum(verdicts),
  /** Rubric points the answer covered ("acertou"). */
  matched: z.array(z.string()),
  /** Rubric points missing ("faltou"). */
  missing: z.array(z.string()),
  /** Drug, dose, route or conduct contrary to the rubric: forces grade `again`. */
  criticalError: z.boolean(),
  feedback: z.string(),
  model: z.string().min(1),
  /** Set by the server from token usage. The model reply is not trusted for this. */
  costCents: z.number().nonnegative().optional(),
  /** G22: set by the server (status, flag id, quota left). A `fallback` verdict came from the local grader. */
  ai: aiInfoSchema.optional(),
  /** G22 (CCR-072, grader/v3): the card's source (rubric) the verdict rests on. */
  source: z.string().nullable().optional(),
  /** G22 (CCR-072): rubric point copied literally by the model; null when it is not in the rubric. */
  sourceQuote: z.string().nullable().optional(),
});
export type GraderVerdict = z.infer<typeof graderVerdictSchema>;

const generateBase = { area: z.enum(areas), title: z.string().min(1) };
export const generateBoardInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1), ...generateBase }),
  z.object({ kind: z.literal('pdf'), pdfAssetId: idSchema, ...generateBase }),
]);
export type GenerateBoardInput = z.infer<typeof generateBoardInputSchema>;

export const generationStages = ['ocr', 'extract', 'layout'] as const;
export const boardGenerationProgressSchema = z.object({
  jobId: idSchema,
  status: z.enum(jobStatuses),
  progress: z.number().min(0).max(100),
  stage: z.enum(generationStages).nullable(),
  boardId: idSchema.nullable(), // set when status = done
  /** Failure code (`canceled`, `text_too_long`, an AiErrorCode, ...); `ai.message` has the text to show. */
  error: z.string().nullable(),
  ai: aiInfoSchema.nullable().optional(),
  cards: z.number().int().nonnegative().optional(),
  edges: z.number().int().nonnegative().optional(),
  pages: z.number().int().nonnegative().optional(),
  /** Cards dropped: no source excerpt found in the text, or over the plan's card limit. */
  dropped: z.number().int().nonnegative().optional(),
});
export type BoardGenerationProgress = z.infer<typeof boardGenerationProgressSchema>;

