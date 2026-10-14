/** G28 / CCR150 / D1845: approved design, first local contract wave. No ENAMED relabeling or legacy backfill. */
import { z } from 'zod';
import { idSchema } from './common';

export const healthProfessionCodes = [
  'medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy',
  'biomedicine', 'nutrition', 'speech_therapy', 'physical_education',
  'veterinary_medicine', 'occupational_therapy',
] as const;
export const healthLanguageTags = ['pt', 'pt-BR', 'pt-PT'] as const;
export const healthProfessionCodeSchema = z.enum(healthProfessionCodes);
export const healthLanguageTagSchema = z.enum(healthLanguageTags);
export type HealthProfessionCode = z.infer<typeof healthProfessionCodeSchema>;
export type HealthLanguageTag = z.infer<typeof healthLanguageTagSchema>;

/** Public classification only; neither branch asserts that a taxonomy node exists or is clinically approved. */
export const healthTaxonomyBindingSchema = z.discriminatedUnion('system', [
  z.object({ system: z.literal('enamed'), areaId: idSchema, topicId: idSchema }).strict(),
  z.object({
    system: z.literal('health'), areaId: idSchema, topicId: idSchema,
    topicKind: z.enum(['topic', 'general']), taxonomyRevision: z.number().int().positive(),
  }).strict(),
]);
export const healthQuestionClassificationSchema = z.object({
  professionCode: healthProfessionCodeSchema,
  /** Secondary tags, never added together as unique-question capacity. */
  professionTags: z.array(healthProfessionCodeSchema).max(11).default([]),
  professionVerified: z.boolean(),
  languageTag: healthLanguageTagSchema,
  languageVerified: z.boolean(),
  taxonomy: healthTaxonomyBindingSchema,
  taxonomyVerified: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.professionTags).size !== value.professionTags.length)
    ctx.addIssue({ code: 'custom', path: ['professionTags'], message: 'duplicate_profession_tags' });
  if (value.professionTags.includes(value.professionCode))
    ctx.addIssue({ code: 'custom', path: ['professionTags'], message: 'primary_profession_repeated' });
  if (value.taxonomy.system === 'enamed' && value.professionCode !== 'medicine')
    ctx.addIssue({ code: 'custom', path: ['taxonomy'], message: 'enamed_requires_medicine' });
});
export type HealthQuestionClassification = z.infer<typeof healthQuestionClassificationSchema>;

/** Admin taxonomy DTO. A reviewed general topic is explicit, never a hidden CM/OUTRO fallback. */
export const healthTaxonomyNodeSchema = z.object({
  id: idSchema, professionCode: healthProfessionCodeSchema,
  kind: z.enum(['area', 'topic', 'general']), parentId: idSchema.nullable(),
  code: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/),
  label: z.string().trim().min(1).max(300), revision: z.number().int().positive(),
  status: z.enum(['draft', 'reviewed', 'withdrawn']),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'area') !== (value.parentId === null))
    ctx.addIssue({ code: 'custom', path: ['parentId'], message: 'invalid_taxonomy_parent' });
  if (value.parentId === value.id)
    ctx.addIssue({ code: 'custom', path: ['parentId'], message: 'taxonomy_self_cycle' });
});
export type HealthTaxonomyNode = z.infer<typeof healthTaxonomyNodeSchema>;
