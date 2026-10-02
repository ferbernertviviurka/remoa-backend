import { z } from 'zod';
import { areas, cardTypes, jobStatuses } from './enums';
import { idSchema } from './common';
import { cardDraftSchema } from './card';
import { boardAccessSchema, boardTitleSchema, matrixItemIdsSchema, refineSharePassword, sharePasswordSchema } from './board';

export const noteTypeKinds = ['basic', 'cloze', 'image_occlusion', 'other'] as const;

export const apkgSummarySchema = z.object({
  /** cardCount = Anki cards; noteCount = notes (one Remoa card each, D-117). */
  decks: z.array(z.object({ id: z.string(), name: z.string(), cardCount: z.number().int().nonnegative(), noteCount: z.number().int().nonnegative() })),
  noteTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(noteTypeKinds),
      fields: z.array(z.string()),
      noteCount: z.number().int().nonnegative(),
      /** F06 FR-3: up to 5 notes, field name -> plain text (HTML stripped, <img> removed), for the mapping preview. */
      samples: z.array(z.record(z.string(), z.string())).max(5),
    }),
  ),
  cardCount: z.number().int().nonnegative(),
  mediaCount: z.number().int().nonnegative(),
});

/** F06 upload flow: presigned PUT of the .apkg to `imports/<userId>/<id>.apkg`, then inspect/start by key. */
export const APKG_MAX_BYTES = 250 * 1024 * 1024;
export const importUploadSignInputSchema = z.object({ sizeBytes: z.number().int().positive().max(APKG_MAX_BYTES) });
export type ImportUploadSignInput = z.infer<typeof importUploadSignInputSchema>;
export const importKeySchema = z.object({ key: z.string().min(1).max(300) });
export type ImportKeyInput = z.infer<typeof importKeySchema>;
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

/** What `toDrafts` yields: a CardDraft plus what the import job needs (D-117). `media[0]` = front image file name. */
export const ankiDraftSchema = z.intersection(
  cardDraftSchema,
  z.object({
    deckId: z.string(),
    deckName: z.string(),
    media: z.array(z.string()),
    /** First image referenced by the back field (→ cards.back_asset_id, D-221); null when none. */
    backMedia: z.string().nullable(),
    /** Anki tags + the sub deck path, already trimmed to the card contract (1–64 chars each, ≤ 50). */
    tags: z.array(z.string().min(1).max(64)).max(50),
    empty: z.boolean(),
  }),
);
export type AnkiDraft = z.infer<typeof ankiDraftSchema>;

/** F17 FR-11: `'new'` creates a board; `{ boardId }` imports into that own active board (dedupe D-118, items added, access unchanged). */
export const importTargetSchema = z.union([z.literal('new'), z.object({ boardId: idSchema })]);
export type ImportTarget = z.infer<typeof importTargetSchema>;
/** F17 FR-10 "Sobre o mapa": one import = one board (D-282). Access and password only apply to `target: 'new'`. */
export const importBoardInputSchema = z
  .object({
    title: boardTitleSchema,
    area: z.enum(areas).default('CM'),
    matrixItemIds: matrixItemIdsSchema.default([]),
    access: boardAccessSchema.default('owner'),
    password: sharePasswordSchema.optional(),
    target: importTargetSchema.default('new'),
  })
  .superRefine((v, ctx) => {
    if (v.target === 'new') refineSharePassword({ requirePassword: true })(v, ctx);
  });
export type ImportBoardInput = z.input<typeof importBoardInputSchema>;

/**
 * POST /v1/imports/anki: starts the job; progress at GET /v1/imports/:id, report at /report.
 * `board` is optional only while the F06 client (one board per root deck, D-117) is still live; F17/T5 always sends it.
 */
export const startImportInputSchema = importKeySchema.extend({ plan: importPlanSchema, board: importBoardInputSchema.optional() });
export type StartImportInput = z.infer<typeof startImportInputSchema>;

/** F17 FR-11: GET /v1/imports/anki/existing?title= — own active board whose normalised title matches (trim, case, accents). */
export const existingBoardQuerySchema = z.object({ title: boardTitleSchema });
export type ExistingBoardQuery = z.infer<typeof existingBoardQuerySchema>;
export const existingBoardSchema = z.object({ board: z.object({ id: idSchema, title: z.string().min(1) }).nullable() });
export type ExistingBoard = z.infer<typeof existingBoardSchema>;

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
