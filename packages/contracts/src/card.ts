import { z } from 'zod';
import { assetLicenses, cardStatuses, cardTypes } from './enums';
import { idSchema, positionSchema, timestampSchema } from './common';

// --- Payload parts ---------------------------------------------------------
export const flowStepSchema = z.object({ id: z.string().min(1), text: z.string().min(1), note: z.string().optional() });
export type FlowStep = z.infer<typeof flowStepSchema>;

export const caseStages = ['presentation', 'workup', 'diagnosis', 'management'] as const;
export const caseStageSchema = z.enum(caseStages);
export type CaseStage = z.infer<typeof caseStageSchema>;
export const caseStepSchema = z.object({ stage: caseStageSchema, text: z.string().min(1) });
export type CaseStep = z.infer<typeof caseStepSchema>;

/** Polygon vertex in image-relative coordinates (0..1), so masks render at any size. */
export const maskPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const maskSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  assetId: idSchema,
  polygon: z.array(maskPointSchema).min(3),
  label: z.string().min(1),
});
export type Mask = z.infer<typeof maskSchema>;

export const imageMimes = ['image/jpeg', 'image/png', 'image/webp'] as const;
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

export const conceptPayloadSchema = z.object({}).strict();
export const flowPayloadSchema = z.object({ steps: z.array(flowStepSchema).min(2).max(12) });
export const imagePayloadSchema = z.object({ assetId: idSchema, maskIds: z.array(idSchema) });
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
/** Map node without payload (what the canvas needs, F01). */
export const cardSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  type: z.enum(cardTypes),
  title: z.string().min(1),
  front: z.string().nullable(),
  back: z.string().nullable(),
  source: z.string().nullable(),
  position: positionSchema.nullable(), // null = not laid out yet (imports)
  status: z.enum(cardStatuses),
  order: z.number().int(),
  reviewerId: idSchema.nullable(),
  updatedAt: timestampSchema,
});
export type Card = z.infer<typeof cardSchema>;

const withRubric = cardSchema.extend({ rubric: rubricSchema.nullable() });
export const cardConceptSchema = withRubric.extend({ type: z.literal('concept'), payload: conceptPayloadSchema });
export const cardFlowSchema = withRubric.extend({ type: z.literal('flow'), payload: flowPayloadSchema });
export const cardImageSchema = withRubric.extend({ type: z.literal('image'), payload: imagePayloadSchema });
export const cardCaseSchema = withRubric.extend({ type: z.literal('case'), payload: casePayloadSchema });
export type CardConcept = z.infer<typeof cardConceptSchema>;
export type CardFlow = z.infer<typeof cardFlowSchema>;
export type CardImage = z.infer<typeof cardImageSchema>;
export type CardCase = z.infer<typeof cardCaseSchema>;

/** Full card with typed payload, discriminated on `type`. */
export const cardDetailSchema = z.discriminatedUnion('type', [
  cardConceptSchema,
  cardFlowSchema,
  cardImageSchema,
  cardCaseSchema,
]);
export type CardDetail = z.infer<typeof cardDetailSchema>;

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
export const uploadSignInputSchema = z.object({ mime: z.enum(imageMimes), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024) });
export type UploadSignInput = z.infer<typeof uploadSignInputSchema>;
export const uploadSignOutputSchema = z.object({ url: z.string().url(), key: z.string().min(1) });
export type UploadSignOutput = z.infer<typeof uploadSignOutputSchema>;
