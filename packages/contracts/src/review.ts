import { z } from 'zod';
import { challengeModes, fsrsCardStates, grades, inputKinds, mapStates, verdicts } from './enums';
import { idSchema, probabilitySchema, subIdSchema, timestampSchema } from './common';
import { graderVerdictSchema } from './ai';

export const gradeSchema = z.enum(grades);
export const verdictSchema = z.enum(verdicts);
export const mapStateSchema = z.enum(mapStates);

/** FSRS memory fields only: what `schedule`/`preview` read and write. */
export const fsrsMemorySchema = z.object({
  stability: z.number().nonnegative(),
  difficulty: z.number().nonnegative(),
  due: timestampSchema,
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  lastReview: timestampSchema.nullable(),
  state: z.enum(fsrsCardStates),
});
export type FsrsMemory = z.infer<typeof fsrsMemorySchema>;

/** Row of `fsrs_state`, keyed by (user, card, sub). */
export const fsrsStateSchema = fsrsMemorySchema.extend({ userId: idSchema, cardId: idSchema, subId: subIdSchema });
export type FsrsState = z.infer<typeof fsrsStateSchema>;

export const attemptSchema = z.object({
  id: idSchema,
  userId: idSchema,
  cardId: idSchema,
  subId: subIdSchema,
  sessionId: idSchema.nullable(),
  mode: z.enum(challengeModes),
  inputKind: z.enum(inputKinds),
  answerText: z.string().nullable(),
  verdict: graderVerdictSchema.extend({ disputed: z.boolean() }).nullable(),
  grade: gradeSchema,
  gradeOverridden: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});
export type Attempt = z.infer<typeof attemptSchema>;

export const queueReasons = ['due', 'new', 'weak'] as const;
export const queueItemSchema = z.object({
  cardId: idSchema,
  subId: subIdSchema.optional(),
  reason: z.enum(queueReasons),
  mode: z.enum(challengeModes).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/** cardId → estimated recall and map colour. */
export const retrievabilityMapSchema = z.record(idSchema, z.object({ r: probabilitySchema, state: mapStateSchema }));
export type RetrievabilityMap = z.infer<typeof retrievabilityMapSchema>;

const intervalSchema = z.object({ due: timestampSchema, intervalDays: z.number().nonnegative() });
/** Next interval for each of the 4 grades (shown under the buttons). */
export const intervalPreviewSchema = z.object({ again: intervalSchema, hard: intervalSchema, good: intervalSchema, easy: intervalSchema });
export type IntervalPreview = z.infer<typeof intervalPreviewSchema>;

export const recordAttemptOutputSchema = z.object({ state: fsrsStateSchema, due: timestampSchema });
export type RecordAttemptOutput = z.infer<typeof recordAttemptOutputSchema>;
