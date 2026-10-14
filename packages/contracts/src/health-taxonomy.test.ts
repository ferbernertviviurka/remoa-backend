import { describe, expect, it } from 'vitest';
import { healthProfessionCodes, healthLanguageTagSchema, healthProfessionCodeSchema,
  healthQuestionClassificationSchema, healthTaxonomyNodeSchema } from './health-taxonomy';

const id = '10000000-0000-4000-8000-000000000001';
const parent = '10000000-0000-4000-8000-000000000002';
const classification = {
  professionCode: 'nursing', professionVerified: true, languageTag: 'pt-BR', languageVerified: true,
  taxonomy: { system: 'health', areaId: parent, topicId: id, topicKind: 'topic', taxonomyRevision: 1 }, taxonomyVerified: true,
};

describe('G28 / CCR150 profession and language independent of ENAMED', () => {
  it('supports exactly the twelve approved professions, with no legacy clinical-area alias', () => {
    expect(healthProfessionCodes).toHaveLength(12);
    expect(new Set(healthProfessionCodes).size).toBe(12);
    for (const code of healthProfessionCodes) expect(healthProfessionCodeSchema.safeParse(code).success).toBe(true);
    for (const code of ['CM', 'OUTRO', 'health', 'Medicine', '']) expect(healthProfessionCodeSchema.safeParse(code).success).toBe(false);
  });
  it.each(['pt', 'pt-BR', 'pt-PT'])('permits explicit Portuguese tag %s', tag => {
    expect(healthLanguageTagSchema.parse(tag)).toBe(tag);
  });
  it.each(['en', 'en-US', 'es', 'pt-br', '', null])('rejects unsupported/unknown language %s rather than translating', tag => {
    expect(healthLanguageTagSchema.safeParse(tag).success).toBe(false);
  });
  it('keeps a reviewed health topic separate from medical ENAMED', () => {
    expect(healthQuestionClassificationSchema.parse(classification).professionTags).toEqual([]);
    const taxonomy = { system: 'enamed', areaId: parent, topicId: id };
    expect(healthQuestionClassificationSchema.safeParse({ ...classification, taxonomy }).success).toBe(false);
    expect(healthQuestionClassificationSchema.safeParse({ ...classification, professionCode: 'medicine', taxonomy }).success).toBe(true);
  });
  it('accepts explicit general-topic classification without pretending it is a specific topic', () => {
    const parsed = healthQuestionClassificationSchema.parse({ ...classification, taxonomy: { ...classification.taxonomy, topicKind: 'general' } });
    expect(parsed.taxonomy).toMatchObject({ system: 'health', topicKind: 'general' });
  });
  it('secondary professions do not repeat the primary or inflate their own list', () => {
    expect(healthQuestionClassificationSchema.safeParse({ ...classification, professionTags: ['pharmacy', 'nutrition'] }).success).toBe(true);
    for (const professionTags of [['nursing'], ['pharmacy', 'pharmacy'], Array(12).fill('pharmacy')])
      expect(healthQuestionClassificationSchema.safeParse({ ...classification, professionTags }).success).toBe(false);
  });
  it('rejects unsafe self-parent and ambiguous root structure', () => {
    const node = { id, professionCode: 'nursing', kind: 'topic', parentId: parent, code: 'nursing.topic', label: 'Fixture topic', revision: 1, status: 'reviewed' };
    expect(healthTaxonomyNodeSchema.safeParse(node).success).toBe(true);
    expect(healthTaxonomyNodeSchema.safeParse({ ...node, parentId: id }).success).toBe(false);
    expect(healthTaxonomyNodeSchema.safeParse({ ...node, parentId: null }).success).toBe(false);
    expect(healthTaxonomyNodeSchema.safeParse({ ...node, kind: 'area' }).success).toBe(false);
    expect(healthTaxonomyNodeSchema.safeParse({ ...node, kind: 'area', parentId: null }).success).toBe(true);
  });
  it('strict DTOs reject legacy-area forgery and unknown fields', () => {
    expect(healthQuestionClassificationSchema.safeParse({ ...classification, area: 'CM' }).success).toBe(false);
    expect(healthQuestionClassificationSchema.safeParse({ ...classification, taxonomy: { ...classification.taxonomy, medicalApproved: true } }).success).toBe(false);
  });
});
