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
  /** ts-fsrs short-term (re)learning step index and last interval (D-056). */
  learningSteps: z.number().int().nonnegative().default(0),
  scheduledDays: z.number().int().nonnegative().default(0),
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
  boardId: idSchema, // "7 em Sepse": the queue screen groups by board
  subId: subIdSchema.optional(),
  reason: z.enum(queueReasons),
  mode: z.enum(challengeModes).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

/** Default new items per day until entitlements (F08) set 20 Pro / 10 Free. */
export const DEFAULT_NEW_PER_DAY = 20;
/** GET /v1/review/queue?boardId&limit */
export const queueQuerySchema = z.object({
  boardId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

/** cardId → estimated recall and map colour. */
export const retrievabilityMapSchema = z.record(
  idSchema,
  z.object({
    r: probabilitySchema,
    state: mapStateSchema,
    due: timestampSchema.nullable().optional(), // inspector "Próxima revisão" (F01)
    subs: z.record(z.string(), z.object({ r: probabilitySchema, state: mapStateSchema })).optional(), // flow steps / masks by sub_id (F02)
  }),
);
export type RetrievabilityMap = z.infer<typeof retrievabilityMapSchema>;

/**
 * F03 FR-9 (D-491): POST /v1/review/cards/:id/{suspend|unsuspend|reset}, empty body, owner only (404 otherwise).
 * suspend/unsuspend set/clear `cards.suspended_at` (idempotent; FSRS state kept, so "retomar" picks up where it was).
 * reset deletes the caller's `fsrs_state` rows of the card (every sub_id): it comes back as new; `attempts` history is kept.
 * Suspended cards: out of the daily/board queue, challenge items, due counts; still on the map (state as usual).
 */
export const cardStudyActions = ['suspend', 'unsuspend', 'reset'] as const;
export const cardStudyActionSchema = z.enum(cardStudyActions);
export type CardStudyAction = z.infer<typeof cardStudyActionSchema>;
export const cardStudyStateSchema = z.object({ cardId: idSchema, suspendedAt: timestampSchema.nullable() });
export type CardStudyState = z.infer<typeof cardStudyStateSchema>;

const intervalSchema = z.object({ due: timestampSchema, intervalDays: z.number().nonnegative() });
/** Next interval for each of the 4 grades (shown under the buttons). */
export const intervalPreviewSchema = z.object({ again: intervalSchema, hard: intervalSchema, good: intervalSchema, easy: intervalSchema });
export type IntervalPreview = z.infer<typeof intervalPreviewSchema>;

export const recordAttemptOutputSchema = z.object({ state: fsrsStateSchema, due: timestampSchema });
export type RecordAttemptOutput = z.infer<typeof recordAttemptOutputSchema>;
