import { z } from 'zod';
import { areas, boardStatuses, cardTypes, mapStates } from './enums';
import { idSchema, positionSchema, timestampSchema } from './common';
import { cardSchema } from './card';

export const boardSchema = z.object({
  id: idSchema,
  userId: idSchema,
  title: z.string().min(1),
  area: z.enum(areas),
  matrixItemId: idSchema.nullable(),
  status: z.enum(boardStatuses),
  version: z.number().int().positive(),
  temporalMark: z.string().nullable(),
  reviewerId: idSchema.nullable(),
  sourceBoardId: idSchema.nullable(),
  archivedAt: timestampSchema.nullable(), // archived = hidden from "Meus mapas"
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Board = z.infer<typeof boardSchema>;

/** FR-11: hard cap per board, enforced by the API (createCard fails with `validation`) and pre-checked by the UI. */
export const MAX_CARDS_PER_BOARD = 500;

export const boardTitleSchema = z.string().trim().min(1).max(120);
export const createBoardInputSchema = z.object({
  title: boardTitleSchema,
  area: z.enum(areas).default('CM'),
  /** G01 v2 "Novo mapa" › Detalhes: item da matriz Enamed (também grava `board_matrix_items`). */
  matrixItemId: idSchema.nullable().optional(),
});
export type CreateBoardInput = z.input<typeof createBoardInputSchema>;
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
