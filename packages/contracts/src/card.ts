import { z } from 'zod';
import { assetLicenses, cardShapes, cardStatuses, cardTypes } from './enums';
import { idSchema, positionSchema, timestampSchema } from './common';

// --- Payload parts ---------------------------------------------------------
/** D-201: each step may carry an image (asset the user can read). */
export const flowStepSchema = z.object({ id: z.string().min(1).max(64), text: z.string().trim().min(1).max(500), note: z.string().max(1000).optional(), assetId: idSchema.optional() });
export type FlowStep = z.infer<typeof flowStepSchema>;

export const caseStages = ['presentation', 'workup', 'diagnosis', 'management'] as const;
export const caseStageSchema = z.enum(caseStages);
export type CaseStage = z.infer<typeof caseStageSchema>;
/** D-201: each stage may carry an image. */
export const caseStepSchema = z.object({ stage: caseStageSchema, text: z.string().trim().min(1).max(2000), assetId: idSchema.optional() });
export type CaseStep = z.infer<typeof caseStepSchema>;

/** Polygon vertex in image-relative coordinates (0..1), so masks render at any size. */
export const maskPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const maskSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  assetId: idSchema,
  polygon: z.array(maskPointSchema).min(3).max(64),
  label: z.string().trim().min(1).max(120),
});
export type Mask = z.infer<typeof maskSchema>;
/** F02 open question answered: 30 masks per image. */
export const MAX_MASKS_PER_IMAGE = 30;
/** Mask as stored in an image card payload; `id` is the FSRS sub_id. Rectangles are 4-point polygons. */
export const cardMaskSchema = maskSchema.pick({ id: true, polygon: true, label: true });
export type CardMask = z.infer<typeof cardMaskSchema>;

export const imageMimes = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Asset with short-lived signed URLs for the WebP variants (GET /v1/assets/:id). */
export const assetVariants = ['w800', 'w1600'] as const;
export const assetRefSchema = z.object({
  id: idSchema,
  key: z.string().min(1),
  mime: z.enum(imageMimes),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  license: z.enum(assetLicenses),
  attribution: z.string().nullable(),
});
export type AssetRef = z.infer<typeof assetRefSchema>;
export const assetViewSchema = assetRefSchema.extend({ urls: z.object({ w800: z.string().url(), w1600: z.string().url() }) });
export type AssetView = z.infer<typeof assetViewSchema>;

export const conceptPayloadSchema = z.object({}).strict();
/** D-200: "Conteúdo" — title/front (+ image) only; no back, no rubric, never scheduled. */
export const notePayloadSchema = z.object({}).strict();

/** D-202: user-chosen card size on the map (px at zoom 1); `null` = default for type/shape. */
export const CARD_SIZE_MIN = { w: 140, h: 90 } as const;
export const CARD_SIZE_MAX = { w: 640, h: 560 } as const;
export const cardSizeSchema = z.object({
  w: z.number().int().min(CARD_SIZE_MIN.w).max(CARD_SIZE_MAX.w),
  h: z.number().int().min(CARD_SIZE_MIN.h).max(CARD_SIZE_MAX.h),
});
export type CardSize = z.infer<typeof cardSizeSchema>;
const uniqueIds = (xs: { id: string }[]) => new Set(xs.map((x) => x.id)).size === xs.length;
export const flowPayloadSchema = z.object({ steps: z.array(flowStepSchema).min(2).max(12).refine(uniqueIds, 'duplicate step id') });
/** Masks live inline here (the API mirrors them into `masks`); never burned into the image. */
export const imagePayloadSchema = z.object({
  assetId: idSchema,
  masks: z.array(cardMaskSchema).max(MAX_MASKS_PER_IMAGE).refine(uniqueIds, 'duplicate mask id'),
});
export const casePayloadSchema = z.object({ caseSteps: z.array(caseStepSchema).min(1).max(caseStages.length) });

// --- Rubric (cards.rubric; produced by F05) --------------------------------
export const rubricSchema = z.object({
  points: z.array(z.object({ text: z.string().min(1), essential: z.boolean() })).min(1),
  source: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(cardStatuses),
  reviewerId: idSchema.nullable(),
});
export type Rubric = z.infer<typeof rubricSchema>;

// --- Card --------------------------------------------------------------------
/** What the map card shows without loading the payload (F02 T6). */
export const cardPreviewSchema = z.object({
  steps: z.number().int().nonnegative().optional(),
  stages: z.array(caseStageSchema).optional(),
  masks: z.number().int().nonnegative().optional(),
  assetId: idSchema.optional(),
});
export type CardPreview = z.infer<typeof cardPreviewSchema>;

/** Map node without payload (what the canvas needs, F01). */
export const cardSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  type: z.enum(cardTypes),
  /** D-095: outline on the map; `rect` for flow, image and case. */
  shape: z.enum(cardShapes).default('rect'),
  title: z.string().min(1),
  front: z.string().nullable(),
  /** D-096: optional image on the question side (front); must be an asset the user can read. */
  frontAssetId: idSchema.nullable().default(null),
  back: z.string().nullable(),
  /** D-201: optional image on the answer side (back). */
  backAssetId: idSchema.nullable().default(null),
  /** D-202: user-chosen size; null = default. Changed by the `resizeCards` map op. */
  size: cardSizeSchema.nullable().default(null),
  /** D-204: tags (F06 import keeps Anki tags and sub-deck; P-056). Read-only here for now. */
  tags: z.array(z.string().min(1).max(64)).max(50).default([]),
  source: z.string().nullable(),
  position: positionSchema.nullable(), // null = not laid out yet (imports)
  status: z.enum(cardStatuses),
  order: z.number().int(),
  reviewerId: idSchema.nullable(),
  updatedAt: timestampSchema,
  preview: cardPreviewSchema.optional(),
});
export type Card = z.infer<typeof cardSchema>;

const withRubric = cardSchema.extend({ rubric: rubricSchema.nullable() });
export const cardConceptSchema = withRubric.extend({ type: z.literal('concept'), payload: conceptPayloadSchema });
export const cardFlowSchema = withRubric.extend({ type: z.literal('flow'), payload: flowPayloadSchema });
export const cardImageSchema = withRubric.extend({ type: z.literal('image'), payload: imagePayloadSchema });
export const cardCaseSchema = withRubric.extend({ type: z.literal('case'), payload: casePayloadSchema });
export const cardNoteSchema = withRubric.extend({ type: z.literal('note'), payload: notePayloadSchema });
export type CardConcept = z.infer<typeof cardConceptSchema>;
export type CardFlow = z.infer<typeof cardFlowSchema>;
export type CardImage = z.infer<typeof cardImageSchema>;
export type CardCase = z.infer<typeof cardCaseSchema>;
export type CardNote = z.infer<typeof cardNoteSchema>;

/** Full card with typed payload, discriminated on `type`. */
export const cardDetailSchema = z.discriminatedUnion('type', [
  cardConceptSchema,
  cardFlowSchema,
  cardImageSchema,
  cardCaseSchema,
  cardNoteSchema,
]);
export type CardDetail = z.infer<typeof cardDetailSchema>;

/**
 * PUT /v1/cards/:id body (F02). Status, reviewer, rubric and position are not editable here:
 * status/reviewer belong to the editorial flow (rule 6), position to map ops (F01).
 */
const editable = z.object({
  title: z.string().trim().min(1).max(200),
  /** D-095: only `concept` may use a shape other than `rect` (the API rejects otherwise). */
  shape: z.enum(cardShapes).default('rect'),
  front: z.string().max(5000).nullable(),
  /** D-096: question image (front side). */
  frontAssetId: idSchema.nullable().default(null),
  /** D-201: answer image (back side); ignored for `note`. */
  backAssetId: idSchema.nullable().default(null),
  back: z.string().max(5000).nullable(),
  source: z.string().max(1000).nullable(),
});
export const saveCardInputSchema = z.discriminatedUnion('type', [
  editable.extend({ type: z.literal('concept'), payload: conceptPayloadSchema }),
  editable.extend({ type: z.literal('flow'), payload: flowPayloadSchema }),
  editable.extend({ type: z.literal('image'), payload: imagePayloadSchema }),
  editable.extend({ type: z.literal('case'), payload: casePayloadSchema }),
  editable.extend({ type: z.literal('note'), payload: notePayloadSchema }),
]);
export type SaveCardInput = z.infer<typeof saveCardInputSchema>;

// --- Drafts (AI generation F05, Anki import F06) ---------------------------
const draftBase = z.object({
  /** Local reference so EdgeDraft can point at drafts before they have ids. */
  ref: z.string().min(1),
  title: z.string().min(1),
  front: z.string().nullable(),
  back: z.string().nullable(),
  source: z.string().nullable(),
});
export const maskDraftSchema = maskSchema.pick({ polygon: true, label: true });
export type MaskDraft = z.infer<typeof maskDraftSchema>;
export const cardDraftSchema = z.discriminatedUnion('type', [
  draftBase.extend({ type: z.literal('concept'), payload: conceptPayloadSchema }),
  draftBase.extend({ type: z.literal('flow'), payload: flowPayloadSchema }),
  draftBase.extend({
    type: z.literal('image'),
    /** `media` = file name inside the source package; becomes an asset on save. */
    payload: z.object({ media: z.string().min(1), masks: z.array(maskDraftSchema) }),
  }),
  draftBase.extend({ type: z.literal('case'), payload: casePayloadSchema }),
]);
export type CardDraft = z.infer<typeof cardDraftSchema>;

export const edgeDraftSchema = z.object({ fromRef: z.string().min(1), toRef: z.string().min(1), label: z.string().nullable() });
export type EdgeDraft = z.infer<typeof edgeDraftSchema>;

// --- Uploads (F02 routes) ----------------------------------------------------
/** F13: `avatar` uploads are capped at AVATAR_MAX_BYTES; omitted kind = card image (F02). */
export const uploadKinds = ['card_image', 'avatar'] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const uploadSignInputSchema = z
  .object({ mime: z.enum(imageMimes), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), kind: z.enum(uploadKinds).optional() })
  .refine((v) => v.kind !== 'avatar' || v.sizeBytes <= AVATAR_MAX_BYTES, { message: 'avatar too large', path: ['sizeBytes'] });
export type UploadSignInput = z.infer<typeof uploadSignInputSchema>;
/** `url` is a presigned PUT: send the file with the same Content-Type and Content-Length. */
export const uploadSignOutputSchema = z.object({ url: z.string().url(), key: z.string().min(1) });
export type UploadSignOutput = z.infer<typeof uploadSignOutputSchema>;
/** POST /v1/uploads/complete: converts the original to WebP variants and creates the asset. */
export const uploadCompleteInputSchema = z.object({
  key: z.string().min(1).max(300),
  license: z.enum(assetLicenses).default('own'),
  attribution: z.string().trim().max(300).nullable().default(null),
});
export type UploadCompleteInput = z.input<typeof uploadCompleteInputSchema>;
