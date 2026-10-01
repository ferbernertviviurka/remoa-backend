import { z } from 'zod';
import { areas } from './enums';

/** Year / situation: 3º–4º, 5º–6º, formado. */
export const segments = ['y3_4', 'y5_6', 'graduated'] as const;
export const segmentSchema = z.enum(segments);
export type Segment = z.infer<typeof segmentSchema>;

export const startPaths = ['pdf', 'anki', 'seed'] as const;
export type StartPath = (typeof startPaths)[number];

export const onboardingAnswersSchema = z.object({
  segment: segmentSchema,
  goal: z.string().regex(/^[a-z0-9_]+$/), // e.g. enamed_2027_1 (profiles.goal)
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
