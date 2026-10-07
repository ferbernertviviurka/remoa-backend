import { z } from 'zod';
import { areas, boardAccess, boardStatuses, cardTypes, mapStates } from './enums';
import { idSchema, positionSchema, timestampSchema } from './common';
import { cardSchema, cardSizeSchema } from './card';
import { boardBadges, boardPathSchema } from './content';
import { MAX_MATRIX_ITEMS_PER_BOARD, SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN } from './constants';

// --- F17 access and matrix items (D-281, D-285–D-289) ---------------------------
export const boardAccessSchema = z.enum(boardAccess);
export { MAX_MATRIX_ITEMS_PER_BOARD, SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN } from './constants'; // CCR-058: zod-free in ./constants
/** Duplicates collapse; order is kept (the first one also goes to boards.matrix_item_id). */
export const matrixItemIdsSchema = z
  .array(idSchema)
  .max(MAX_MATRIX_ITEMS_PER_BOARD)
  .transform((ids) => [...new Set(ids)]);
/** Q-034: SHARE_PASSWORD_MIN..MAX characters, no other rule (attempt limit + slow hash do the rest). Never trimmed, never logged. */
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
  /** F17 FR-21 (D-532): every matrix link of the map (`board_matrix_items`, oldest first). Filled by GET/PATCH /v1/boards/:id; absent elsewhere. */
  matrixItemIds: z.array(idSchema).optional(),
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
  /** F31 (CCR-080): trail of a ready map (and of its copies); absent/null = ordinary map. */
  path: boardPathSchema.nullable().optional(),
  /** F31 (D-1461): library seals, e.g. `top10_enamed`; only on seed boards. */
  badges: z.array(z.enum(boardBadges)).optional(),
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
    access: boardAccessSchema.default('owner'),
    password: sharePasswordSchema.optional(),
  })
  .superRefine(refineSharePassword({ requirePassword: true }));
export type CreateBoardInput = z.input<typeof createBoardInputSchema>;
/**
 * POST /v1/ai/generate-pdf (D-532): multipart/form-data with `file` (the PDF) and `board` (JSON of this schema), so the
 * generated map is born with area, items and access like an import. Same shape as createBoard.
 */
export const generatePdfBoardInputSchema = createBoardInputSchema;
/** F17 FR-11 "mapa com o mesmo nome": trim, case and accents ignored. */
export const normalizeBoardTitle = (title: string) => title.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
/**
 * PATCH /v1/boards/:id — rename, archive (`archived: false` restores) and/or change the area (F17 FR-21, D-532: links to
 * matrix items of another area are removed in the same transaction).
 */
export const updateBoardInputSchema = z
  .object({ title: boardTitleSchema, archived: z.boolean(), area: z.enum(areas) })
  .partial()
  .refine((v) => v.title !== undefined || v.archived !== undefined || v.area !== undefined, 'nothing to update');
export type UpdateBoardInput = z.infer<typeof updateBoardInputSchema>;

/**
 * CCR-018 (D-573): GET /v1/boards?status=. `active` (default) = not archived ("Meus mapas", sidebar); `archived` = the
 * "Arquivados" filter; `all` = both. Archived maps do not count toward the Free quota (D-167), live ones do.
 */
export const boardListStatuses = ['active', 'archived', 'all'] as const;
export const boardListQuerySchema = z.object({ status: z.enum(boardListStatuses).default('active') });
export type BoardListQuery = z.input<typeof boardListQuerySchema>;
/**
 * CCR-018 (D-574): DELETE /v1/boards/:id = permanent delete (no soft delete, no undo). Only the owner, only `private`
 * boards (seeds: 404). Cascades in the same statement: cards → edges, fsrs_state, attempts, review_queue, board_matrix_items,
 * board_versions; sessions.board_id → null; copies keep living (source_board_id → null); the share link dies with the row.
 * Card images become orphans and are swept by `cleanup/assets`. Answer `{ id }`. Archived or not, it frees the quota slot.
 */
export const deleteBoardResultSchema = z.object({ id: idSchema });
export type DeleteBoardResult = z.infer<typeof deleteBoardResultSchema>;

/** Row in "Meus mapas" / sidebar. */
export const boardSummarySchema = boardSchema
  .pick({ id: true, title: true, area: true, status: true, updatedAt: true })
  .extend({
    /** CCR-018: null = live; the API always sends it (optional only for older fixtures). */
    archivedAt: timestampSchema.nullable().optional(),
    cardCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    /** G01 v2: item da matriz do mapa (D-081). */
    matrixItemId: idSchema.nullable().default(null),
    /** F17 FR-21 (D-532): every matrix link of the map; the API always sends it. */
    matrixItemIds: z.array(idSchema).optional(),
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

// --- F23 mapa no celular (D-664, D-665): preferências só do aparelho, em localStorage --------------
export const MOBILE_MAP_PREFS_KEY = 'remoa:map-mobile-prefs';
export const MOBILE_MAP_ZOOM_MIN = 0.4;
export const MOBILE_MAP_ZOOM_MAX = 1.8;
/** Abaixo disto o card entra na visão geral (FR-6). */
export const MOBILE_MAP_SEMANTIC_ZOOM = 0.8;
export const MOBILE_MAP_MAX_VIEWPORTS = 50;
/** Última vista de um mapa; `x`/`y` em coordenadas do fluxo (centro), `zoom` já preso a 40%–180%. */
export const mobileMapViewSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().min(MOBILE_MAP_ZOOM_MIN).max(MOBILE_MAP_ZOOM_MAX),
});
export type MobileMapView = z.infer<typeof mobileMapViewSchema>;
/**
 * Lido com `safeParse` e, se falhar, recai em `defaultMobileMapPrefs` (nunca lança). Sem dado de card, sem texto.
 * `favorites` é por aparelho até existir coluna no servidor (CCR-032, D-665).
 */
export const mobileMapPrefsSchema = z.object({
  version: z.literal(1).default(1),
  heat: z.boolean().default(true),
  labels: z.boolean().default(true),
  view: z.enum(['canvas', 'list']).default('canvas'),
  /** boardId → última vista. O cliente poda para os 50 mais recentes. */
  viewports: z.record(idSchema, mobileMapViewSchema).default({}),
  favorites: z.array(idSchema).max(200).default([]),
});
export type MobileMapPrefs = z.infer<typeof mobileMapPrefsSchema>;
export const defaultMobileMapPrefs: MobileMapPrefs = mobileMapPrefsSchema.parse({});
