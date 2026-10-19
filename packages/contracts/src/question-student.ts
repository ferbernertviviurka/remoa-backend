/**
 * F34 / G27 (CCR-147): student question bank (facets, drawer answer) and exam builder (availability, preview, swap,
 * revalidate, templates). Reuses the F33/G26 catalog predicate, session snapshot and reference gate.
 * Answer-key rule (D-1822): nothing here before an answer carries correctKey, explanation, distractor notes or a verdict.
 */
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { catalogAlternativeKeys } from './constants';
import { questionListQuerySchema, questionOrigins, questionReferenceAfterAnswerSchema, questionValidationSchema } from './question-catalog';
import { EXAM_BUILDER_LIMITS, examBuilderParamsSchema, examSeedSchema } from './exam-builder';

const uniqueIds = (max: number) => z.array(idSchema).max(max).default([]).refine((a) => new Set(a).size === a.length, 'duplicate_ids');
const difficulties = ['easy', 'medium', 'hard'] as const;

// --- facets (FR-3, FR-8) ------------------------------------------------------------------------------------------
export const questionFacetGroups = ['area', 'topic', 'institution', 'year', 'difficulty'] as const;
/** GET /v1/questions/facets: the list filters (no cursor/limit/sort) + which groups + optional topic text for the autocomplete. */
export const questionFacetQuerySchema = questionListQuerySchema.omit({ cursor: true, limit: true, sort: true }).extend({
  groups: z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(',')), z.array(z.enum(questionFacetGroups)).min(1).max(5).optional()),
  topicQuery: z.string().trim().min(1).max(100).optional(),
}).strict();
export type QuestionFacetQuery = z.infer<typeof questionFacetQuerySchema>;
const n = z.number().int().nonnegative();
/** Disjunctive counts: each group ignores its own filter and applies all the others. Eligible rows only; distinct canonical ids. */
export const questionFacetsSchema = z.object({
  total: n,
  areas: z.array(z.object({ id: idSchema, count: n }).strict()).max(50).optional(),
  topics: z.array(z.object({ id: idSchema, name: z.string().min(1).max(200), count: n }).strict()).max(50).optional(),
  institutions: z.array(z.object({ name: z.string().min(1).max(300), count: n }).strict()).max(100).optional(),
  years: z.array(z.object({ year: z.number().int(), count: n }).strict()).max(100).optional(),
  difficulties: z.array(z.object({ value: z.enum(difficulties), count: n }).strict()).max(3).optional(),
}).strict();
export type QuestionFacets = z.infer<typeof questionFacetsSchema>;

// --- drawer answer outside a session (FR-15, FR-16) --------------------------------------------------------------
/** POST /v1/questions/:id/answer. Objective only; the server corrects and records an immutable attempt (idempotent by mutationId). */
export const questionDrawerAnswerInputSchema = z.object({ selectedKey: z.enum(catalogAlternativeKeys), mutationId: idSchema, elapsedMs: z.number().int().min(0).max(86400000) }).strict();
export type QuestionDrawerAnswerInput = z.infer<typeof questionDrawerAnswerInputSchema>;
/** Returned only after the attempt is stored; also GET /v1/questions/:id/attempt → { last: this | null }. */
export const questionDrawerAttemptSchema = z.object({
  questionId: idSchema, selectedKey: z.enum(catalogAlternativeKeys), result: z.enum(['correct', 'incorrect', 'annulled']), answeredAt: timestampSchema, reference: questionReferenceAfterAnswerSchema,
}).strict();
export type QuestionDrawerAttempt = z.infer<typeof questionDrawerAttemptSchema>;
export const questionLastAttemptSchema = z.object({ last: questionDrawerAttemptSchema.nullable() }).strict();

// --- availability (FR-24) ----------------------------------------------------------------------------------------
/** POST /v1/exam-builder/availability (read-only, no draw). areaId null = own AI question without area. */
export const examAvailabilitySchema = z.object({ total: n, areas: z.array(z.object({ areaId: idSchema.nullable(), available: n }).strict()).max(51) }).strict();
export type ExamAvailability = z.infer<typeof examAvailabilitySchema>;

// --- preview, swap, revalidate (FR-27, FR-28) --------------------------------------------------------------------
const seedSchema = examSeedSchema;
/** POST /v1/exam-builder/preview. No seed = server draws a new one ("Sortear de novo"); pinned stay, excluded never come back. */
export const examPreviewInputSchema = z.object({ params: examBuilderParamsSchema, seed: seedSchema.optional(), pinnedIds: uniqueIds(EXAM_BUILDER_LIMITS.maxQuestions), excludedIds: uniqueIds(EXAM_BUILDER_LIMITS.maxExcluded) }).strict();
export type ExamPreviewInput = z.input<typeof examPreviewInputSchema>;
/** Safe projection only (no alternatives, key, explanation or verdict). stemPreview ≤ 280 chars. */
export const examPreviewItemSchema = z.object({
  questionId: idSchema, canonicalId: idSchema, version: z.number().int().positive(), areaId: idSchema.nullable(), topicId: idSchema.nullable(),
  origin: z.enum(questionOrigins), difficulty: z.enum(difficulties), difficultyAssessment: z.literal('unassessed').optional(), stemPreview: z.string().min(1).max(280), sourceLabel: z.string().max(300).nullable(),
  validation: questionValidationSchema.nullable(), pinned: z.boolean(),
}).strict();
export type ExamPreviewItem = z.infer<typeof examPreviewItemSchema>;
const allocationRowSchema = z.object({ areaId: idSchema.nullable(), available: n, target: n, allocated: n }).strict();
export const examPreviewSchema = z.object({
  seed: seedSchema, allocation: z.object({ rows: z.array(allocationRowSchema).max(51), requested: n, allocated: n, shortfall: n }).strict(),
  items: z.array(examPreviewItemSchema).max(EXAM_BUILDER_LIMITS.maxQuestions),
}).strict();
export type ExamPreview = z.infer<typeof examPreviewSchema>;
/** POST /v1/exam-builder/swap ("Trocar"): next question of the same area and filters not in currentIds ∪ excludedIds; 409 no_replacement. */
export const examSwapInputSchema = z.object({ params: examBuilderParamsSchema, seed: seedSchema, questionId: idSchema, currentIds: uniqueIds(EXAM_BUILDER_LIMITS.maxQuestions), excludedIds: uniqueIds(EXAM_BUILDER_LIMITS.maxExcluded) }).strict();
export const examSwapResultSchema = z.object({ item: examPreviewItemSchema }).strict();
/** POST /v1/exam-builder/revalidate: before "Começar" (and after a 409 exam_changed). Read-only. */
export const examRevalidateInputSchema = z.object({ params: examBuilderParamsSchema, questionIds: z.array(idSchema).min(1).max(EXAM_BUILDER_LIMITS.maxQuestions).refine((a) => new Set(a).size === a.length, 'duplicate_ids') }).strict();
export const examRevalidateResultSchema = z.object({
  ok: z.boolean(),
  /** No longer eligible, not objective/active, or outside params.source. */
  unavailable: z.array(idSchema).max(EXAM_BUILDER_LIMITS.maxQuestions),
  /** A newer published version exists: the client may swap to latestId and must ask again. */
  updated: z.array(z.object({ id: idSchema, latestId: idSchema }).strict()).max(EXAM_BUILDER_LIMITS.maxQuestions),
}).strict().refine((r) => r.ok === (r.unavailable.length === 0 && r.updated.length === 0), 'ok_mismatch');
export type ExamRevalidateResult = z.infer<typeof examRevalidateResultSchema>;

// --- saved templates (FR-31, FR-4) -------------------------------------------------------------------------------
export const examTemplateInputSchema = z.object({ name: z.string().trim().min(1).max(EXAM_BUILDER_LIMITS.templateName), params: examBuilderParamsSchema }).strict();
export type ExamTemplateInput = z.input<typeof examTemplateInputSchema>;
export const examTemplateSchema = z.object({ id: idSchema, name: z.string().min(1).max(EXAM_BUILDER_LIMITS.templateName), params: examBuilderParamsSchema, createdAt: timestampSchema, updatedAt: timestampSchema }).strict();
export type ExamTemplate = z.infer<typeof examTemplateSchema>;
/** GET /v1/exam-templates (owner only, newest first). limit = PlanDefinition.exam_templates (null = unlimited). */
export const examTemplateListSchema = z.object({ items: z.array(examTemplateSchema).max(100), limit: z.number().int().nonnegative().nullable() }).strict();
