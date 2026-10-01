import { z } from 'zod';
import { areas } from './enums';
import { idSchema, probabilitySchema } from './common';

export const weakCardSchema = z.object({ cardId: idSchema, boardId: idSchema, title: z.string(), r: probabilitySchema });
export type WeakCard = z.infer<typeof weakCardSchema>;

export const areaAccuracySchema = z.object({
  area: z.enum(areas),
  matrixItemId: idSchema.nullable(), // null = whole area
  attempts: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  accuracy: probabilitySchema.nullable(), // null when attempts = 0
});
export type AreaAccuracy = z.infer<typeof areaAccuracySchema>;

export const progressSummarySchema = z.object({
  /** correct ÷ attempts; null without attempts in the window. */
  retention7d: probabilitySchema.nullable(),
  retention30d: probabilitySchema.nullable(),
  reviewsPerDay: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().nonnegative() })),
  streakDays: z.number().int().nonnegative(),
  weakCards: z.array(weakCardSchema).max(20),
  accuracy: z.array(areaAccuracySchema),
});
export type ProgressSummary = z.infer<typeof progressSummarySchema>;
