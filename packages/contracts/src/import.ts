import { z } from 'zod';
import { cardTypes, jobStatuses } from './enums';
import { idSchema } from './common';

export const noteTypeKinds = ['basic', 'cloze', 'image_occlusion', 'other'] as const;

export const apkgSummarySchema = z.object({
  decks: z.array(z.object({ id: z.string(), name: z.string(), cardCount: z.number().int().nonnegative() })),
  noteTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(noteTypeKinds),
      fields: z.array(z.string()),
      noteCount: z.number().int().nonnegative(),
    }),
  ),
  cardCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
});
export type ApkgSummary = z.infer<typeof apkgSummarySchema>;

/** How one Anki note type becomes a Remoa card (field names from ApkgSummary). */
export const fieldMappingSchema = z.object({
  noteTypeId: z.string(),
  cardType: z.enum(cardTypes),
  title: z.string().nullable(), // null = derive from front
  front: z.string(),
  back: z.string().nullable(),
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

/** Output of `plan(summary, mappings)`: what `toDrafts` will produce. */
export const importPlanSchema = z.object({
  deckIds: z.array(z.string()).min(1), // one board per deck
  mappings: z.array(fieldMappingSchema),
  estimatedCards: z.number().int().nonnegative(),
});
export type ImportPlan = z.infer<typeof importPlanSchema>;

export const importProgressSchema = z.object({
  importId: idSchema,
  status: z.enum(jobStatuses),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type ImportProgress = z.infer<typeof importProgressSchema>;

export const importReportSchema = z.object({
  importId: idSchema,
  boardIds: z.array(idSchema),
  imported: z.number().int().nonnegative(),
  skippedDuplicate: z.number().int().nonnegative(),
  skippedEmpty: z.number().int().nonnegative(),
  missingMedia: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type ImportReport = z.infer<typeof importReportSchema>;
