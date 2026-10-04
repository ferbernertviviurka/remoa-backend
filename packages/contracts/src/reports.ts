import { z } from 'zod';
import { areas } from './enums';
import { idSchema, probabilitySchema } from './common';

export const weakCardSchema = z.object({ cardId: idSchema, boardId: idSchema, title: z.string(), r: probabilitySchema });
export type WeakCard = z.infer<typeof weakCardSchema>;

export const areaAccuracySchema = z.object({
  area: z.enum(areas),
  matrixItemId: idSchema.nullable(), // null = whole area
  /** Title of the matrix item, when the attempts were linked to one. */
  label: z.string().min(1).nullable().optional(),
  attempts: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  accuracy: probabilitySchema.nullable(), // null when attempts = 0
});
export type AreaAccuracy = z.infer<typeof areaAccuracySchema>;

export const progressSummarySchema = z.object({
  /** correct ÷ attempts; null without attempts in the window. */
  retention7d: probabilitySchema.nullable(),
  retention30d: probabilitySchema.nullable(),
  /** Exactly 30 days, oldest first. Days without a review count as zero. */
  reviewsPerDay: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().nonnegative() })).length(30),
  streakDays: z.number().int().nonnegative(),
  weakCards: z.array(weakCardSchema).max(20),
  accuracy: z.array(areaAccuracySchema),
});
export type ProgressSummary = z.infer<typeof progressSummarySchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** G01 v2 "Hoje": progress of the day, the week (Mon–Sun of the profile's time zone, day turns at 04h like the queue) and the next days. */
export const homeSummarySchema = z.object({
  /** Items rated today and items still due today (ring "3 de 15" = reviewedToday / (reviewedToday + dueToday)). */
  reviewedToday: z.number().int().nonnegative(),
  dueToday: z.number().int().nonnegative(),
  /** Exactly 7 entries, Monday first. `done` = attempts rated that day; `planned` = items due that day (future days only, 0 for past). */
  week: z.array(z.object({ date: isoDate, done: z.number().int().nonnegative(), planned: z.number().int().nonnegative() })).length(7),
  /** Consecutive days up to today (or yesterday, if nothing yet today) with at least one rated attempt. */
  streakDays: z.number().int().nonnegative(),
  /** Today and the next 3 days: items due on each day (today = dueToday). */
  upcoming: z.array(z.object({ date: isoDate, count: z.number().int().nonnegative() })).length(4),
});
export type HomeSummary = z.infer<typeof homeSummarySchema>;
