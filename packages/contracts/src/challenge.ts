import { z } from 'zod';
import { challengeModes, sessionKinds, type Grade } from './enums';
import { idSchema, subIdSchema, timestampSchema } from './common';
import { gradeSchema, intervalPreviewSchema, queueFilterSchema } from './review';
import { graderVerdictSchema } from './ai';
import { caseStageSchema, maskPointSchema } from './card';

/** Default and max items per session (PRD: 12 items in < 8 min; "Mais 5" starts a 5-item session). */
export const SESSION_SIZE = 12;
export const MAX_SKIPS_PER_ITEM = 2;
/** Upper bound of `limit` (default stays SESSION_SIZE): the Revisar hub starts the whole filtered selection. */
export const REVIEW_SESSION_MAX = 100;

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

// --- CCR-019 session options (D-575–D-577) ---------------------------------------
/**
 * "Desafiar este mapa" needs at least this many challengeable cards on the board (live, not `note`, not suspended).
 * The web disables the button below it; the server answers 422 `challengeErrors.minCards` for board sessions.
 */
export const CHALLENGE_MIN_CARDS = 10;
/** `self` = the student reveals the answer and marks Acertei/Errei (no AI). `ai` = F20 "Desafio com IA" (Em breve). */
export const gradingModes = ['self', 'ai'] as const;
/** `random` = shuffled; `flow` = follow the arrows (edges, from the roots; cycles broken by card order). */
export const challengeOrders = ['random', 'flow'] as const;
/** How the student answers: `write` (text box) or `voice` (Em breve). */
export const answerModes = ['write', 'voice'] as const;
export type GradingMode = (typeof gradingModes)[number];
export type ChallengeOrder = (typeof challengeOrders)[number];
export type AnswerMode = (typeof answerModes)[number];
/** What the server accepts today; the web shows the others as "Em breve" (disabled). */
export const CHALLENGE_OPTION_AVAILABLE = {
  gradingMode: { self: true, ai: false },
  order: { random: true, flow: true },
  answerMode: { write: true, voice: false },
} as const satisfies { gradingMode: Record<GradingMode, boolean>; order: Record<ChallengeOrder, boolean>; answerMode: Record<AnswerMode, boolean> };
export const challengeOptionsSchema = z
  .object({
    gradingMode: z.enum(gradingModes).default('self'),
    order: z.enum(challengeOrders).default('random'),
    answerMode: z.enum(answerModes).default('write'),
  })
  .strict();
export type ChallengeOptions = z.infer<typeof challengeOptionsSchema>;
export const DEFAULT_CHALLENGE_OPTIONS: ChallengeOptions = { gradingMode: 'self', order: 'random', answerMode: 'write' };
/** `AppError.message` values of POST /v1/challenge/sessions (code `validation`, 422). */
export const challengeErrors = {
  minCards: 'challenge_min_cards',
  gradingModeUnavailable: 'grading_mode_unavailable',
  answerModeUnavailable: 'answer_mode_unavailable',
} as const;
/** First unavailable option → its error message; null = all available. Server and web use the same check. */
export const unavailableChallengeOption = (o: ChallengeOptions): string | null =>
  !CHALLENGE_OPTION_AVAILABLE.gradingMode[o.gradingMode]
    ? challengeErrors.gradingModeUnavailable
    : !CHALLENGE_OPTION_AVAILABLE.answerMode[o.answerMode]
      ? challengeErrors.answerModeUnavailable
      : null;
/**
 * D-576: self mode has two buttons after revealing; each becomes the FSRS grade sent to POST /v1/challenge/rate.
 * Acertei → `good`, Errei → `again` (the 4-grade scale stays on "Revisar hoje"). `overridden: false`.
 */
export const selfMarks = ['correct', 'wrong'] as const;
export type SelfMark = (typeof selfMarks)[number];
export const SELF_MARK_GRADE = { correct: 'good', wrong: 'again' } as const satisfies Record<SelfMark, Grade>;

export const startSessionInputSchema = z
  .object({
    kind: z.enum(sessionKinds),
    boardId: idSchema.optional(),
    /** Up to REVIEW_SESSION_MAX (G15, D-641): "Começar revisão · N" runs the whole selection. */
    limit: z.number().int().min(1).max(REVIEW_SESSION_MAX).default(SESSION_SIZE),
    /** G15: daily sessions only; restrict the queue by boards/area/reasons, or `ahead`. */
    filter: queueFilterSchema.optional(),
    /** CCR-019: stored in sessions.options; absent = DEFAULT_CHALLENGE_OPTIONS. `order` only matters for board sessions. */
    options: challengeOptionsSchema.default(DEFAULT_CHALLENGE_OPTIONS),
  })
  .refine((v) => (v.kind === 'board') === !!v.boardId, 'board sessions need boardId (and only they)')
  .refine((v) => !v.filter || v.kind === 'daily', 'filter only applies to daily sessions');
export type StartSessionInput = z.input<typeof startSessionInputSchema>;
export const startSessionOutputSchema = z.object({
  sessionId: idSchema,
  items: z.array(challengeItemPublicSchema),
  /** CCR-019: the options the server applied (defaults filled). */
  options: challengeOptionsSchema.default(DEFAULT_CHALLENGE_OPTIONS),
});
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
  /** null for self-assessment, mcq, a `gradingMode: 'self'` session (D-577: text is kept, never sent to the AI), or when AI grading is unavailable/out of quota. */
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
