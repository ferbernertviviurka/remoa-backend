import { z } from 'zod';
import { areas, jobStatuses, verdicts } from './enums';
import { idSchema } from './common';
import { rubricSchema } from './card';

/** Stored as the card source until a person reviews an AI draft (F05). */
export const AI_DRAFT_SOURCE = 'Gerado por IA, não revisado';

export const graderInputSchema = z.object({
  prompt: z.string().min(1),
  canonical: z.string().min(1),
  rubric: rubricSchema,
  /** Neighbour cards/labels as plain text context. */
  neighbors: z.array(z.string()),
  answer: z.string().min(1).max(4000),
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
  error: z.string().nullable(),
});
export type BoardGenerationProgress = z.infer<typeof boardGenerationProgressSchema>;

