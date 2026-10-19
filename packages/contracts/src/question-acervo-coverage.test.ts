import { describe, expect, it } from 'vitest';
import { questionAcervoCoverageSchema, questionCatalogMetricsSchema } from './question-catalog';

const coverage = {
  eligibleTotal: 12,
  byCourse: [{ course: 'medicine', count: 10 }, { course: 'physical_education', count: 2 }],
  unclassifiedArea: 11, unclassifiedTopic: 12,
  sourceAreaTags: [{ code: 'clinica-medica', count: 2 }, { code: 'cirurgia', count: 2 }],
  sourceAreaTagsUnreviewed: true,
};
const audit = { id: 1, createdAt: '2026-10-19T00:00:00Z', actorType: 'admin', actor: null, action: 'question.import_view', targetType: 'route', targetId: '/v1/admin/questions/metrics', targetLabel: null, reason: 'Consultar métricas', result: 'success', denial: null, before: null, after: null, ipHash: null, userAgent: null, requestId: null };
const metrics = { publicCanonical: 12, importsByStatus: [], candidateCounts: [], documents: 0, generatedPrivate: 0, duplicateOrVersionNotCounted: true, audit };

describe('G29 audited acervo coverage contract', () => {
  it('keeps historical metric responses without inventing zero coverage', () => {
    expect(questionCatalogMetricsSchema.parse(metrics)).not.toHaveProperty('acervoCoverage');
    expect(questionCatalogMetricsSchema.parse({ ...metrics, acervoCoverage: coverage }).acervoCoverage).toEqual(coverage);
  });
  it('accepts empty eligible corpus and explicitly unreviewed overlapping source tags', () => {
    expect(questionAcervoCoverageSchema.safeParse({ eligibleTotal: 0, byCourse: [], unclassifiedArea: 0, unclassifiedTopic: 0, sourceAreaTags: [], sourceAreaTagsUnreviewed: true }).success).toBe(true);
    const overlapping = { ...coverage, sourceAreaTags: [{ code: 'clinica-medica', count: 12 }, { code: 'cirurgia', count: 12 }] };
    expect(questionAcervoCoverageSchema.parse(overlapping).sourceAreaTags).toHaveLength(2);
  });
  it.each([
    { byCourse: [{ course: 'medicine', count: 11 }] },
    { byCourse: [{ course: 'medicine', count: 10 }, { course: 'medicine', count: 2 }] },
    { byCourse: [{ course: 'invented', count: 12 }] },
    { unclassifiedArea: 13 }, { unclassifiedTopic: 13 }, { eligibleTotal: -1 },
    { sourceAreaTags: [{ code: 'clinica-medica', count: 13 }] },
    { sourceAreaTags: [{ code: 'clinica-medica', count: 1 }, { code: 'clinica-medica', count: 1 }] },
    { sourceAreaTags: [{ code: 'fabricated-topic', count: 1 }] },
    { sourceAreaTagsUnreviewed: false }, { reviewed: true }, { correctKey: 'A' },
  ])('rejects inconsistent counts or fabricated classification %#', extra => {
    expect(questionAcervoCoverageSchema.safeParse({ ...coverage, ...extra }).success).toBe(false);
  });
});
