import { z } from 'zod';
import { areas, isAreaAvailable } from './enums';
import { timestampSchema } from './common';

/** Year / situation. Append-only (rows stored); UI order lives in the frontend. */
export const segments = ['y3_4', 'y5_6', 'graduated', 'y1_2', 'cursinho', 'resident', 'working'] as const;
export const segmentSchema = z.enum(segments);
export type Segment = z.infer<typeof segmentSchema>;

/** F13: exam goal (profiles.goal). */
export const goals = [
  'enamed_2027_1', 'enamed_2027_2', 'undecided',
  'enamed_2028_1', 'enamed_2028_2', 'residencia_enare', 'residencia_sus_sp', 'residencia_usp',
  'residencia_unifesp', 'residencia_outras', 'provas_faculdade', 'manter_atualizado',
] as const;
export const goalSchema = z.enum(goals);
export type Goal = z.infer<typeof goalSchema>;
/** CCR-017 (D-570): objectives are multi-select. Duplicates collapse, order kept; `goals[0]` is mirrored to profiles.goal. */
export const MAX_GOALS = 5;
export const goalsSchema = z
  .array(goalSchema)
  .max(MAX_GOALS)
  .transform((g) => [...new Set(g)]);

export const startPaths = ['pdf', 'anki', 'seed'] as const;
export type StartPath = (typeof startPaths)[number];

export const onboardingAnswersSchema = z.object({
  segment: segmentSchema,
  goal: z.string().regex(/^[a-z0-9_]+$/), // e.g. enamed_2027_1 (profiles.goal); F13 reads it through goalSchema
  /** CCR-017: the multi-select step (preferred over `goal`); saved to profiles.goals (and goals[0] to profiles.goal). */
  goals: goalsSchema.pipe(z.array(goalSchema).min(1)).optional(),
  area: z.enum(areas),
  startPath: z.enum(startPaths),
});
export type OnboardingAnswers = z.infer<typeof onboardingAnswersSchema>;

export const waitlistEntrySchema = z.object({
  email: z.string().email(),
  segment: segmentSchema,
  variant: z.string().regex(/^\d+$/).nullable(), // price variant from ?v=29 / ?v=49
  origin: z.string().max(200).nullable(),
});
export type WaitlistEntry = z.infer<typeof waitlistEntrySchema>;

// --- F12 onboarding + activation checklist (CCR-015, D-492/D-493) -------------------------------------------
/** POST /v1/onboarding/answers: every step is skippable, so any subset; merged into profiles.onboarding_answers. */
export const onboardingAnswersPatchSchema = onboardingAnswersSchema
  .partial()
  .refine((a) => Object.keys(a).length > 0, 'empty answers')
  // CCR-017 (D-572): areas without content yet are shown as "Em breve" and cannot be picked.
  .refine((a) => a.area === undefined || isAreaAvailable(a.area), { message: 'area not available yet', path: ['area'] });
export type OnboardingAnswersPatch = z.infer<typeof onboardingAnswersPatchSchema>;

/**
 * FR-9 checklist, counted by the server over the user's live boards: non-note live cards, edges, ended sessions (any kind).
 * "Instalar no celular" is not here: only the browser knows (display-mode standalone); the web adds it locally.
 */
export const ACTIVATION_TARGETS = { cards: 20, edges: 5, sessions: 1 } as const;
export const activationItems = ['cards', 'edges', 'sessions'] as const;
export const activationItemSchema = z.object({
  id: z.enum(activationItems),
  current: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  done: z.boolean(),
});
export type ActivationItem = z.infer<typeof activationItemSchema>;

/** GET /v1/onboarding, and the answer of both POSTs. `doneAt` null = show the onboarding (redirect after sign-up). */
export const onboardingStateSchema = z.object({
  doneAt: timestampSchema.nullable(),
  answers: onboardingAnswersSchema.partial(),
  checklist: z.array(activationItemSchema),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;
