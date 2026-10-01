import { z } from 'zod';
import { challengeModes, sessionKinds } from './enums';
import { idSchema, subIdSchema, timestampSchema } from './common';
import { gradeSchema, intervalPreviewSchema } from './review';
import { graderVerdictSchema } from './ai';

/** Server-side item, frozen in `sessions.items`. `canonical` never leaves the server before answer/reveal. */
export const challengeItemSchema = z.object({
  id: z.string().min(1),
  cardId: idSchema,
  subId: subIdSchema,
  mode: z.enum(challengeModes),
  prompt: z.string().min(1),
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

export const startSessionInputSchema = z.object({ kind: z.enum(sessionKinds), boardId: idSchema.optional() });
export type StartSessionInput = z.infer<typeof startSessionInputSchema>;
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
