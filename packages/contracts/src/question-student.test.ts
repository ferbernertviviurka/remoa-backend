import { describe, expect, it } from 'vitest';
import { allocateExam, examBuilderParamsSchema, questionSessionBuilderSchema } from './exam-builder';
import { examPreviewItemSchema, examRevalidateResultSchema, questionFacetQuerySchema } from './question-student';
import { questionFeatureFlagsSchema, questionListQuerySchema, questionSessionConfigSchema } from './question-catalog';
import { mockExamPreview } from './mocks/question-catalog';

const A = '34000000-0000-4000-8000-00000000000a', B = '34000000-0000-4000-8000-00000000000b', C = '34000000-0000-4000-8000-00000000000c';
// Tiny deterministic PRNG so the property loop is reproducible.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe('allocateExam (FR-25/FR-26, D-1825)', () => {
  it('balanced splits evenly and redistributes the remainder of a short area', () => {
    const r = allocateExam([{ areaId: B, available: 3 }, { areaId: A, available: 50 }, { areaId: C, available: 50 }], 30, 'balanced');
    expect(r.rows.map((x) => [x.areaId, x.allocated, x.target])).toEqual([[A, 14, 10], [B, 3, 10], [C, 13, 10]]);
    expect(r.shortfall).toBe(0);
  });
  it('proportional follows availability (D\'Hondt) and never completes beyond what exists', () => {
    expect(allocateExam([{ areaId: A, available: 90 }, { areaId: B, available: 10 }], 10, 'proportional').rows.map((x) => x.allocated)).toEqual([9, 1]);
    const short = allocateExam([{ areaId: A, available: 4 }, { areaId: B, available: 2 }], 10, 'proportional');
    expect([short.allocated, short.shortfall]).toEqual([6, 4]);
  });
  it('is order independent and keeps pinned questions in their area', () => {
    const areas = [{ areaId: A, available: 5, pinned: 2 }, { areaId: B, available: 5 }];
    expect(allocateExam(areas, 4, 'balanced')).toEqual(allocateExam([...areas].reverse(), 4, 'balanced'));
    expect(allocateExam([{ areaId: A, available: 5, pinned: 3 }, { areaId: B, available: 5 }], 4, 'balanced').rows.map((x) => x.allocated)).toEqual([3, 1]);
    expect(() => allocateExam([{ areaId: A, available: 5, pinned: 3 }], 2, 'balanced')).toThrow('pinned_exceeds_count');
  });
  it('properties: sum = min(N, available), each ≤ available, ≥ pinned, balanced is max–min fair', () => {
    const next = rng(7);
    for (let run = 0; run < 500; run++) {
      const areas = [A, B, C, null].slice(0, 1 + Math.floor(next() * 4)).map((areaId) => { const available = Math.floor(next() * 30); return { areaId, available, pinned: Math.floor(next() * Math.min(available, 3)) }; });
      const pinned = areas.reduce((s, a) => s + a.pinned, 0), total = areas.reduce((s, a) => s + a.available, 0);
      const count = pinned + Math.floor(next() * 60);
      for (const d of ['balanced', 'proportional'] as const) {
        const r = allocateExam(areas, count, d);
        expect(r.allocated).toBe(Math.min(count, total));
        expect(r.allocated + r.shortfall).toBe(count);
        r.rows.forEach((row) => { const a = areas.find((x) => x.areaId === row.areaId)!; expect(row.allocated).toBeLessThanOrEqual(a.available); expect(row.allocated).toBeGreaterThanOrEqual(a.pinned); });
        if (d === 'balanced') {
          const open = r.rows.filter((row) => row.allocated < row.available && row.allocated > (areas.find((x) => x.areaId === row.areaId)!.pinned));
          const min = Math.min(...r.rows.filter((row) => row.allocated < row.available).map((row) => row.allocated));
          open.forEach((row) => expect(row.allocated).toBeLessThanOrEqual(min + 1));
        }
      }
    }
  });
});

describe('F34 contracts (CCR-147)', () => {
  it('preview items cannot carry an answer key, explanation or alternatives (D-1822)', () => {
    const item = mockExamPreview.items[0]!;
    for (const leak of ['correctKey', 'explanation', 'distractorNotes', 'alternatives', 'result']) expect(examPreviewItemSchema.safeParse({ ...item, [leak]: 'A' }).success).toBe(false);
  });
  it('list query takes repeated params, a single value, and the sort', () => {
    const q = questionListQuerySchema.parse({ topicIds: A, years: ['2025', '2026'], difficulties: ['easy', 'hard'], sort: 'topic' });
    expect([q.topicIds, q.years, q.sort]).toEqual([[A], [2025, 2026], 'topic']);
    expect(questionListQuerySchema.safeParse({ areaIds: [A, A] }).success).toBe(false);
    expect(questionFacetQuerySchema.parse({ groups: 'area,topic', topicQuery: ' card ' })).toMatchObject({ groups: ['area', 'topic'], topicQuery: 'card' });
  });
  it('builder snapshot requires an explicit question list; flags carry bankStudent', () => {
    const builder = questionSessionBuilderSchema.parse({ seed: 'a'.repeat(32), params: { count: 1, mode: 'study' } });
    expect(questionSessionConfigSchema.safeParse({ mode: 'study', count: 1, filters: {}, builder }).success).toBe(false);
    expect(questionSessionConfigSchema.safeParse({ mode: 'study', count: 1, questionIds: [A], builder }).success).toBe(true);
    expect(examBuilderParamsSchema.parse({ count: 10, mode: 'study' })).toMatchObject({ source: 'catalog', distribution: 'balanced', progress: 'all', timePerQuestionSec: null, areaIds: [] });
    expect(questionFeatureFlagsSchema.safeParse({ import: false, catalog: true, sessions: true }).success).toBe(false);
    expect(examRevalidateResultSchema.safeParse({ ok: true, unavailable: [A], updated: [] }).success).toBe(false);
  });
});
