/**
 * F34 / G27 (CCR-147): exam-builder params, starter presets, deterministic allocation and the session snapshot block.
 * No catalog import here: question-catalog.ts (session config) depends on this file, never the other way round.
 */
import { z } from 'zod';
import { idSchema } from './common';

const uniqueIds = (max: number) => z.array(idSchema).max(max).default([]).refine((a) => new Set(a).size === a.length, 'duplicate_ids');
const difficulties = ['easy', 'medium', 'hard'] as const;
export const EXAM_BUILDER_LIMITS = { minQuestions: 1, maxQuestions: 200, shortcuts: [10, 20, 40, 100], previewVisible: 7, maxSelection: 200, maxAreas: 20, maxTopics: 100, maxExcluded: 400, templateName: 80 } as const;
export const examSeedSchema = z.string().regex(/^[a-f0-9]{32}$/);

// --- exam builder params (FR-22, FR-23) --------------------------------------------------------------------------
/** `catalog` = public eligible only; `ai` = own private ai_generated (F30); `catalog_and_ai` only by explicit choice (D-1823). */
export const examBuilderSources = ['catalog', 'catalog_and_ai', 'ai'] as const;
export const examBuilderProgress = ['all', 'unseen', 'wrong'] as const;
export const examBuilderDistributions = ['balanced', 'proportional'] as const;
export type ExamBuilderDistribution = typeof examBuilderDistributions[number];
export const examBuilderFilterSchema = z.object({
  source: z.enum(examBuilderSources).default('catalog'),
  /** [] = every area with available questions. */
  areaIds: uniqueIds(EXAM_BUILDER_LIMITS.maxAreas),
  topicIds: uniqueIds(EXAM_BUILDER_LIMITS.maxTopics),
  /** FR-37: map matrix items; the server resolves them to taxonomy topics (item or its children). */
  matrixItemIds: uniqueIds(EXAM_BUILDER_LIMITS.maxTopics),
  difficulties: z.array(z.enum(difficulties)).max(3).default([]).refine((a) => new Set(a).size === a.length, 'duplicate_difficulty'),
  progress: z.enum(examBuilderProgress).default('all'),
  /** D-1846: map as base. Restricts the private ai_generated pool to questions generated from this map (the catalog part is unaffected). null = any map. */
  boardId: idSchema.nullable().default(null),
}).strict();
export type ExamBuilderFilter = z.infer<typeof examBuilderFilterSchema>;
export const examBuilderParamsSchema = examBuilderFilterSchema.extend({
  count: z.number().int().min(EXAM_BUILDER_LIMITS.minQuestions).max(EXAM_BUILDER_LIMITS.maxQuestions),
  distribution: z.enum(examBuilderDistributions).default('balanced'),
  /** null = sem tempo; 180 or 120 s per question. */
  timePerQuestionSec: z.union([z.literal(120), z.literal(180)]).nullable().default(null),
  mode: z.enum(['study', 'simulation']),
  shuffle: z.boolean().default(false),
}).strict();
export type ExamBuilderParams = z.infer<typeof examBuilderParamsSchema>;
export type ExamBuilderParamsInput = z.input<typeof examBuilderParamsSchema>;
/** FR-22 starter presets. The ENAMED preset's per-area split is "balanced" (Q-107: no official split in the Matrix; D-1826). */
export const examBuilderPresets = {
  enamed: { count: 100, distribution: 'balanced', mode: 'simulation', timePerQuestionSec: 180, progress: 'all' },
  quick: { count: 10, distribution: 'balanced', mode: 'study', timePerQuestionSec: null, progress: 'unseen' },
  mistakes: { count: 20, distribution: 'balanced', mode: 'study', timePerQuestionSec: null, progress: 'wrong' },
  blank: { count: 20, distribution: 'balanced', mode: 'study', timePerQuestionSec: null, progress: 'all' },
} as const satisfies Record<string, Partial<ExamBuilderParamsInput>>;

// --- deterministic allocation (FR-25, FR-26) — shared by the server preview and the builder bars -----------------
export type AllocationArea = { areaId: string | null; available: number; pinned?: number };
export type AllocationRow = { areaId: string | null; available: number; target: number; allocated: number };
export type Allocation = { rows: AllocationRow[]; requested: number; allocated: number; shortfall: number };
const key = (a: { areaId: string | null }) => a.areaId ?? '';
function fill(areas: AllocationArea[], count: number, distribution: ExamBuilderDistribution, capped: boolean): number[] {
  const alloc = areas.map((a) => a.pinned ?? 0);
  const cap = (i: number) => (capped ? Math.max(areas[i]!.available, areas[i]!.pinned ?? 0) : Infinity);
  // Proportional weight is the area's real availability even when uncapped (target), so empty areas never get a target there.
  const priority = (i: number) => (distribution === 'balanced' ? -alloc[i]! : areas[i]!.available / (alloc[i]! + 1));
  for (let left = count - alloc.reduce((s, x) => s + x, 0); left > 0; left--) {
    let best = -1;
    for (let i = 0; i < areas.length; i++) {
      if (alloc[i]! >= cap(i) || (distribution === 'proportional' && areas[i]!.available === 0)) continue;
      if (best < 0) { best = i; continue; }
      const d = priority(i) - priority(best);
      if (d > 0 || (d === 0 && (areas[i]!.available > areas[best]!.available || (areas[i]!.available === areas[best]!.available && key(areas[i]!) < key(areas[best]!))))) best = i;
    }
    if (best < 0) break;
    alloc[best]!++;
  }
  return alloc;
}
/**
 * Deterministic, order-independent allocation of `count` questions over `areas` (chosen areas, or every area with available > 0).
 * Start from the pinned count of each area, then hand out one question at a time to the eligible area with the best priority:
 *  - balanced: lowest current allocation (max–min fair; capacity limits redistribute the remainder to the other areas);
 *  - proportional: highest available / (allocated + 1) (D'Hondt divisor method over availability).
 * Ties: larger availability, then areaId ascending. Never exceeds availability; never completes from another source (D-1825).
 * `target` = the same rule without capacity (what the area would get with enough questions) → the "X de N por área" warning.
 */
export function allocateExam(areas: readonly AllocationArea[], count: number, distribution: ExamBuilderDistribution): Allocation {
  const sorted = [...areas].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const pinned = sorted.reduce((s, a) => s + (a.pinned ?? 0), 0);
  if (!Number.isInteger(count) || count < 0 || pinned > count) throw new RangeError('pinned_exceeds_count');
  const allocated = fill(sorted, count, distribution, true), target = fill(sorted, count, distribution, false);
  const total = allocated.reduce((s, x) => s + x, 0);
  return { rows: sorted.map((a, i) => ({ areaId: a.areaId, available: a.available, target: target[i]!, allocated: allocated[i]! })), requested: count, allocated: total, shortfall: count - total };
}

/** Stored inside question_sessions.config (snapshot of how the exam was built). Start = POST /v1/question-sessions with questionIds + builder. */
export const questionSessionBuilderSchema = z.object({ seed: examSeedSchema, params: examBuilderParamsSchema, templateId: idSchema.nullable().default(null) }).strict();

// --- D-1846: AI questions generated on the fly from a map, before the preview -------------------------------------
/** Objective only (sessions take objective). Reuses the map's unseen saved questions first, then the model; charges ai_question_batches like F32. */
export const EXAM_GENERATE_MAX = 20;
export const examGenerateInputSchema = z.object({
  boardId: idSchema,
  count: z.number().int().min(1).max(EXAM_GENERATE_MAX),
  difficulty: z.enum([...difficulties, 'mixed']).default('mixed'),
}).strict();
export type ExamGenerateInput = z.input<typeof examGenerateInputSchema>;
export const examGenerateResultSchema = z.object({
  /** Delivered ids (reused first): pin them in the preview. Never a stem or an answer key here. */
  questionIds: z.array(idSchema).max(EXAM_GENERATE_MAX),
  requested: z.number().int().min(0),
  reused: z.number().int().min(0),
  generated: z.number().int().min(0),
  shortfall: z.number().int().min(0),
  stoppedBy: z.enum(['quota', 'ai_error']).nullable(),
}).strict();
export type ExamGenerateResult = z.infer<typeof examGenerateResultSchema>;
