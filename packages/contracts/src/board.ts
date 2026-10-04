import { z } from 'zod';
import { areas, boardAccess, boardStatuses, cardTypes, mapStates } from './enums';
import { idSchema, positionSchema, timestampSchema } from './common';
import { cardSchema, cardSizeSchema } from './card';

// --- F17 access and matrix items (D-281, D-285–D-289) ---------------------------
export const boardAccessSchema = z.enum(boardAccess);
/** F17 FR-5: at most 10 matrix items per board (leaf items of the board's area; the API answers 422 otherwise). */
export const MAX_MATRIX_ITEMS_PER_BOARD = 10;
/** Duplicates collapse; order is kept (the first one also goes to boards.matrix_item_id). */
export const matrixItemIdsSchema = z
  .array(idSchema)
  .max(MAX_MATRIX_ITEMS_PER_BOARD)
  .transform((ids) => [...new Set(ids)]);
/** Q-034: 6..64 characters, no other rule (attempt limit + slow hash do the rest). Never trimmed, never logged. */
export const SHARE_PASSWORD_MIN = 6;
export const SHARE_PASSWORD_MAX = 64;
export const sharePasswordSchema = z.string().min(SHARE_PASSWORD_MIN).max(SHARE_PASSWORD_MAX);
/**
 * Password rule shared by every input that sets an access level: required with `password`, rejected with the others
 * (a stale password from the form must not travel). `requirePassword: false` = keep the current one (UpdateShareInput).
 */
export const refineSharePassword =
  ({ requirePassword }: { requirePassword: boolean }) =>
  (v: { access?: (typeof boardAccess)[number]; password?: string }, ctx: z.RefinementCtx) => {
    if (v.access === 'password' && requirePassword && v.password === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'password required for access=password' });
    if (v.access !== 'password' && v.password !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'password only with access=password' });
  };

export const boardSchema = z.object({
  id: idSchema,
  userId: idSchema,
  title: z.string().min(1),
  area: z.enum(areas),
  matrixItemId: idSchema.nullable(),
  status: z.enum(boardStatuses),
  version: z.number().int().positive(),
  temporalMark: z.string().nullable(),
  /** F10: texto do changelog da última versão publicada (deste mapa ou do seed de origem). */
  changelog: z.string().nullable().optional(),
  reviewerId: idSchema.nullable(),
  sourceBoardId: idSchema.nullable(),
  archivedAt: timestampSchema.nullable(), // archived = hidden from "Meus mapas"
  /** F17: who can open the board by link. The token, hash and version never leave the server (see ShareState). */
  access: boardAccessSchema.default('owner'),
  /** F17: `${APP_URL}/m/<token>` while access ≠ owner; owner-only responses. Optional until every route fills it. */
  shareUrl: z.string().url().nullable().optional(),
  /** F17 FR-16: set when the board is a copy made from a shared link (never the original's id or owner). */
  copiedFrom: z.object({ at: timestampSchema }).nullable().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Board = z.infer<typeof boardSchema>;

/** FR-11: hard cap per board, enforced by the API (createCard fails with `validation`) and pre-checked by the UI. */
export const MAX_CARDS_PER_BOARD = 500;

export const boardTitleSchema = z.string().trim().min(1).max(120);
export const createBoardInputSchema = z
  .object({
    title: boardTitleSchema,
    area: z.enum(areas).default('CM'),
    /** F17 FR-17: matrix items (→ `board_matrix_items`; the first also → boards.matrix_item_id). */
    matrixItemIds: matrixItemIdsSchema.default([]),
    /** @deprecated G01 single item; read through `boardMatrixItemIds(input)`. */
    matrixItemId: idSchema.nullable().optional(),
    access: boardAccessSchema.default('owner'),
    password: sharePasswordSchema.optional(),
  })
  .superRefine(refineSharePassword({ requirePassword: true }));
export type CreateBoardInput = z.input<typeof createBoardInputSchema>;
/** Effective item list: `matrixItemIds` when non-empty, else the deprecated `matrixItemId`. */
export const boardMatrixItemIds = (input: { matrixItemIds?: string[]; matrixItemId?: string | null }): string[] =>
  input.matrixItemIds?.length ? input.matrixItemIds : input.matrixItemId ? [input.matrixItemId] : [];
/** F17 FR-11 "mapa com o mesmo nome": trim, case and accents ignored. */
export const normalizeBoardTitle = (title: string) => title.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
/** PATCH /v1/boards/:id — rename and/or archive (`archived: false` restores). */
export const updateBoardInputSchema = z
  .object({ title: boardTitleSchema, archived: z.boolean() })
  .partial()
  .refine((v) => v.title !== undefined || v.archived !== undefined, 'nothing to update');
export type UpdateBoardInput = z.infer<typeof updateBoardInputSchema>;

/** Row in "Meus mapas" / sidebar. */
export const boardSummarySchema = boardSchema
  .pick({ id: true, title: true, area: true, status: true, updatedAt: true })
  .extend({
    cardCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    /** G01 v2: item da matriz do mapa (D-081). */
    matrixItemId: idSchema.nullable().default(null),
    /** F17 FR-19: badge on the card when ≠ owner. */
    access: boardAccessSchema.default('owner'),
    dueCount: z.number().int().nonnegative().default(0), // F03 FR-8: sidebar badge, items due today
    /** G01: state bar and the sidebar dot (dominant state). Card-level states (D-057 aggregate). */
    stateCounts: z
      .object(Object.fromEntries(mapStates.map((k) => [k, z.number().int().nonnegative()])) as Record<(typeof mapStates)[number], z.ZodNumber>)
      .default({ review: 0, watch: 0, steady: 0, unknown: 0 }),
    /** G01: graph thumbnail. Positions normalised to 0..1 in the board's bounding box; at most PREVIEW_MAX_NODES nodes. */
    preview: z
      .object({
        nodes: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), state: z.enum(mapStates) })),
        /** Index pairs into `nodes`. */
        edges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
      })
      .default({ nodes: [], edges: [] }),
  });
export const PREVIEW_MAX_NODES = 60;
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const edgeSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  fromCardId: idSchema,
  toCardId: idSchema,
  label: z.string().nullable(), // no label = never becomes a question
  question: z.string().nullable(),
});
export type Edge = z.infer<typeof edgeSchema>;

/** Board as loaded by the canvas (cards without payload). */
export const boardGraphSchema = z.object({ board: boardSchema, cards: z.array(cardSchema), edges: z.array(edgeSchema) });
export type BoardGraph = z.infer<typeof boardGraphSchema>;

const edgeLabelSchema = z.string().max(120).nullable();

// --- Map operations (idempotent by opId; autosave queue, F01) --------------
const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.object({ op: z.literal(name), opId: idSchema, boardId: idSchema, ...shape });

export const mapOpSchema = z.discriminatedUnion('op', [
  op('moveCards', { moves: z.array(z.object({ cardId: idSchema, position: positionSchema })).min(1).max(500) }),
  /** D-202: user resizes cards; `size: null` restores the default for the type/shape. */
  op('resizeCards', { sizes: z.array(z.object({ cardId: idSchema, size: cardSizeSchema.nullable() })).min(1).max(500) }),
  op('createCard', { card: z.object({ id: idSchema, type: z.enum(cardTypes), title: z.string().min(1).max(200), position: positionSchema }) }),
  op('createEdge', { edge: edgeSchema.pick({ id: true, fromCardId: true, toCardId: true }).extend({ label: edgeLabelSchema }) }),
  op('updateEdgeLabel', { edgeId: idSchema, label: edgeLabelSchema }),
  op('deleteCards', { cardIds: z.array(idSchema).min(1) }),
  op('deleteEdges', { edgeIds: z.array(idSchema).min(1) }),
]);
export type MapOp = z.infer<typeof mapOpSchema>;

/** POST /v1/boards/ops body. Ops apply in order, each one idempotent (client-generated ids). */
export const applyMapOpsInputSchema = z.object({ ops: z.array(mapOpSchema).min(1).max(200) });
export type ApplyMapOpsInput = z.infer<typeof applyMapOpsInputSchema>;
