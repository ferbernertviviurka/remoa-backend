import { z } from 'zod';
import { challengeModes, sessionKinds } from './enums';
import { idSchema, subIdSchema, timestampSchema } from './common';
import { gradeSchema, intervalPreviewSchema } from './review';
import { graderVerdictSchema } from './ai';
import { caseStageSchema, maskPointSchema } from './card';

/** Default and max items per session (PRD: 12 items in < 8 min; "Mais 5" starts a 5-item session). */
export const SESSION_SIZE = 12;
export const MAX_SKIPS_PER_ITEM = 2;

/**
 * What the screen shows around the question. Never contains the answer: the answer card/label is left out of
 * `neighbors`, and occlusion masks carry polygons only (labels are answers).
 */
export const challengeContextSchema = z.object({
  /** "No mapa": neighbour cards with the connection label (null = unlabelled). */
  neighbors: z.array(z.object({ title: z.string(), label: z.string().nullable() })).max(12),
  /** next_step: steps 1..k; case: revealed stage texts, in order. */
  revealed: z.array(z.string()).optional(),
  /** case: the stage being asked. */
  stage: caseStageSchema.optional(),
  /** occlusion: the image and every mask polygon; `maskId` is the one asked (covered differently). */
  image: z
    .object({
      assetId: idSchema,
      maskId: idSchema,
      masks: z.array(z.object({ id: idSchema, polygon: z.array(maskPointSchema).min(3) })),
    })
    .optional(),
  /** edge: the two ends ("O que liga A a B?"). */
  edge: z.object({ fromTitle: z.string(), toTitle: z.string() }).optional(),
});
export type ChallengeContext = z.infer<typeof challengeContextSchema>;

/** Text answers are AI-graded only against an approved rubric, or the student's own rubric on a private card ("rubrica sua"). */
export const gradingKinds = ['rubric_approved', 'rubric_own', 'none'] as const;

/** Server-side item, frozen in `sessions.items`. `canonical` never leaves the server before answer/reveal. */
export const challengeItemSchema = z.object({
  id: z.string().min(1),
  cardId: idSchema,
  boardId: idSchema,
  cardTitle: z.string(),
  subId: subIdSchema,
  mode: z.enum(challengeModes),
  prompt: z.string().min(1),
  context: challengeContextSchema,
  grading: z.enum(gradingKinds),
  options: z.array(z.string().min(1)).length(4).optional(),
  canonical: z.string().min(1),
});
export type ChallengeItem = z.infer<typeof challengeItemSchema>;

/** What the client receives before answering. */
export const challengeItemPublicSchema = challengeItemSchema.omit({ canonical: true });
export type ChallengeItemPublic = z.infer<typeof challengeItemPublicSchema>;

export const challengeSessionSchema = z.object({
  id: idSchema,
  userId: idSchema,
  boardId: idSchema.nullable(),
  kind: z.enum(sessionKinds),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  items: z.array(challengeItemSchema),
});
export type ChallengeSession = z.infer<typeof challengeSessionSchema>;

export const startSessionInputSchema = z
  .object({ kind: z.enum(sessionKinds), boardId: idSchema.optional(), limit: z.number().int().min(1).max(SESSION_SIZE).default(SESSION_SIZE) })
  .refine((v) => (v.kind === 'board') === !!v.boardId, 'board sessions need boardId (and only they)');
export type StartSessionInput = z.input<typeof startSessionInputSchema>;
export const startSessionOutputSchema = z.object({ sessionId: idSchema, items: z.array(challengeItemPublicSchema) });
export type StartSessionOutput = z.infer<typeof startSessionOutputSchema>;

const answerBase = { sessionId: idSchema, itemId: z.string().min(1), durationMs: z.number().int().nonnegative() };
export const answerInputSchema = z.discriminatedUnion('inputKind', [
  z.object({ inputKind: z.literal('self'), ...answerBase }), // "Revelar resposta"
  z.object({ inputKind: z.literal('mcq'), optionIndex: z.number().int().min(0).max(3), ...answerBase }),
  z.object({ inputKind: z.literal('text'), text: z.string().min(1).max(4000), ...answerBase }),
  z.object({ inputKind: z.literal('voice'), text: z.string().min(1).max(4000), ...answerBase }), // transcript only
]);
export type AnswerInput = z.infer<typeof answerInputSchema>;

export const answerOutputSchema = z.object({
  canonical: z.string(),
  /** null for self-assessment, mcq, or when AI grading is unavailable/out of quota. */
  verdict: graderVerdictSchema.nullable(),
  suggestedGrade: gradeSchema.nullable(),
  /** true when criticalError locks the grade at `again`. */
  gradeLocked: z.boolean(),
  /** Why a text answer was not AI-graded (the UI falls back to self-assessment and says why); null otherwise. */
  fallback: z.enum(['no_rubric', 'quota', 'grader_error', 'offline']).nullable(),
  preview: intervalPreviewSchema,
});
export type AnswerOutput = z.infer<typeof answerOutputSchema>;

export const rateInputSchema = z.object({ sessionId: idSchema, itemId: z.string().min(1), grade: gradeSchema, overridden: z.boolean() });
export type RateInput = z.infer<typeof rateInputSchema>;

export const itemRefSchema = z.object({ sessionId: idSchema, itemId: z.string().min(1) });
export type ItemRef = z.infer<typeof itemRefSchema>;

export const sessionSummarySchema = z.object({
  sessionId: idSchema,
  correct: z.number().int().nonnegative(),
  wrong: z.number().int().nonnegative(),
  toReview: z.array(idSchema),
  nextDue: timestampSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
