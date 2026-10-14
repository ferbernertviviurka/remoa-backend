// G28-P / F35 (CCR-160): study profile ("Seu estudo"), health-area reference data and the central capability rules.
// Codes are stable and stored (study_profiles, reference tables, DB checks): append only, never rename. Labels live in the
// reference tables (content) and @remoa/strings.
import { z } from 'zod';
import { brUfSchema } from './account';
import { MAX_GOALS } from './constants';
import { idSchema as uuidSchema, timestampSchema } from './common';
export * from './study-profile-core';
import { councilCodes, healthCourseKinds, institutionTypes, studyGoalCodes, studyProfileSources, studySituations, STUDY_PROFILE_LIMITS } from './study-profile-core';
export { healthCourseCodeSchema } from './health-course-codes';

import { healthCourseCodeSchema } from './health-course-codes';

export const studySituationSchema = z.enum(studySituations);


export const councilCodeSchema = z.enum(councilCodes);

export const studyGoalCodeSchema = z.enum(studyGoalCodes);




// --- reference DTOs (GET /v1/public/reference/*) ------------------------------------------------------------------
export const healthCourseSchema = z.object({
  code: healthCourseCodeSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  kind: z.enum(healthCourseKinds),
  councilCode: councilCodeSchema.nullable(),
  suggestedGoals: z.array(studyGoalCodeSchema),
});
export type HealthCourse = z.infer<typeof healthCourseSchema>;
export const councilSchema = z.object({ code: councilCodeSchema, name: z.string() });
export type Council = z.infer<typeof councilSchema>;
/** `courseCodes` null = any course. */
export const studyGoalSchema = z.object({ code: studyGoalCodeSchema, name: z.string(), courseCodes: z.array(healthCourseCodeSchema).nullable() });
export type StudyGoal = z.infer<typeof studyGoalSchema>;
export const institutionSchema = z.object({
  id: uuidSchema, name: z.string(), acronym: z.string().nullable(), city: z.string(), uf: brUfSchema, type: z.enum(institutionTypes),
});
export type Institution = z.infer<typeof institutionSchema>;

/** Shape of packages/db/seed/reference/*.json (content lane -> seed loader). */
export const referenceSeedSchemas = {
  councils: z.array(councilSchema),
  'health-courses': z.array(healthCourseSchema.extend({ sort: z.number().int() })),
  'study-goals': z.array(studyGoalSchema),
  institutions: z.array(institutionSchema.omit({ id: true }).extend({
    emecCode: z.coerce.number().int().positive(), acronym: z.string().min(1).nullable(), city: z.string().min(1),
  })),
};
export type ReferenceSeed = { [K in keyof typeof referenceSeedSchemas]: z.infer<(typeof referenceSeedSchemas)[K]> };

export const institutionsQuerySchema = z.object({
  q: z.string().transform((s) => s.trim()).pipe(z.string().min(2).max(80)),
  uf: brUfSchema.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type InstitutionsQuery = z.infer<typeof institutionsQuerySchema>;
export const studyGoalsQuerySchema = z.object({ course: healthCourseCodeSchema.optional() });

/** FR-6 "Usar o que digitei": counted per normalized text in reference_suggestions; the author is never stored. */
export const referenceSuggestionKinds = ['course', 'institution', 'goal'] as const;
const freeText = (max: number) => z.string().transform((s) => s.trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(max));
export const referenceSuggestionInputSchema = z.object({ kind: z.enum(referenceSuggestionKinds), text: freeText(160) }).strict();
export type ReferenceSuggestionInput = z.infer<typeof referenceSuggestionInputSchema>;

// --- study profile -------------------------------------------------------------------------------------------------
/**
 * PUT /v1/account/study-profile (and POST .../confirm, same body). Server rules on top of this: with `institutionId` it
 * overwrites city/uf/institutionType from the institutions row; councilNumber is dropped when the course has no council.
 */
export const studyProfileInputSchema = z
  .object({
    situation: studySituationSchema,
    course: healthCourseCodeSchema,
    courseOtherText: freeText(STUDY_PROFILE_LIMITS.courseOther).nullish(),
    institutionId: uuidSchema.nullish(),
    institutionText: freeText(STUDY_PROFILE_LIMITS.institutionText).nullish(),
    city: freeText(STUDY_PROFILE_LIMITS.city).nullish(),
    uf: brUfSchema.nullish(),
    institutionType: z.enum(institutionTypes).nullish(),
    period: z.number().int().min(1).max(12).nullish(),
    goals: z.array(studyGoalCodeSchema).max(MAX_GOALS).default([]).transform((g) => [...new Set(g)]),
    customGoals: z.array(freeText(STUDY_PROFILE_LIMITS.customGoal)).max(STUDY_PROFILE_LIMITS.customGoals).default([]),
    /** Private (owner only), optional, never verified (FR-20, Q-117). */
    councilNumber: z.string().trim().regex(/^[A-Za-z0-9./ -]+$/).min(1).max(STUDY_PROFILE_LIMITS.councilNumber).nullish(),
    nonHealthTopic: freeText(STUDY_PROFILE_LIMITS.nonHealthTopic).nullish(),
    /** Sign-up step 2 sends 'signup'; everything else is 'profile'. */
    context: z.enum(['signup', 'profile']).default('profile'),
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (v.goals.length + v.customGoals.length === 0) bad('goals', 'at least one goal');
    if ((v.course === 'other_health') !== !!v.courseOtherText) bad('courseOtherText', 'required only for other_health');
    if ((v.course === 'not_health') !== !!v.nonHealthTopic) bad('nonHealthTopic', 'required only for not_health');
    if (v.period != null && (v.situation !== 'graduacao' || v.course === 'not_health')) bad('period', 'only for health students');
    if (v.councilNumber != null && v.situation !== 'profissional') bad('councilNumber', 'only for profissional');
    if (v.institutionId && v.institutionText) bad('institutionText', 'institutionId or institutionText, not both');
  });
export type StudyProfileInput = z.input<typeof studyProfileInputSchema>;
export type StudyProfileInputParsed = z.output<typeof studyProfileInputSchema>;
export const studyProfileConfirmSchema = studyProfileInputSchema;

/** GET response. Only ever returned to its owner (councilNumber included). situation/course null only while source = migration. */
export const studyProfileSchema = z.object({
  situation: studySituationSchema.nullable(),
  course: healthCourseCodeSchema.nullable(),
  courseOtherText: z.string().nullable(),
  institution: institutionSchema.nullable(),
  institutionText: z.string().nullable(),
  city: z.string().nullable(),
  uf: brUfSchema.nullable(),
  institutionType: z.enum(institutionTypes).nullable(),
  period: z.number().int().nullable(),
  goals: z.array(studyGoalCodeSchema),
  customGoals: z.array(z.string()),
  councilNumber: z.string().nullable(),
  nonHealthTopic: z.string().nullable(),
  source: z.enum(studyProfileSources),
  updatedAt: timestampSchema,
});
export type StudyProfile = z.infer<typeof studyProfileSchema>;

