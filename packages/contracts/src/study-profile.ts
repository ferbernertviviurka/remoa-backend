// G28-P / F35 (CCR-160): study profile ("Seu estudo"), health-area reference data and the central capability rules.
// Codes are stable and stored (study_profiles, reference tables, DB checks): append only, never rename. Labels live in the
// reference tables (content) and @remoa/strings.
import { z } from 'zod';
import { brUfSchema } from './account';
import { MAX_GOALS } from './constants';
import { idSchema as uuidSchema, timestampSchema } from './common';

export { healthCourseCodes, healthCourseCodeSchema } from './health-course-codes';
import { healthCourseCodes, healthCourseCodeSchema } from './health-course-codes';
export type HealthCourseCode = z.infer<typeof healthCourseCodeSchema>;
/** `other_health` = "Outro curso da saúde" (free text), `not_health` = "Não é da área da saúde" (topic free text). */
export const healthCourseKinds = ['course', 'other_health', 'not_health'] as const;
export type HealthCourseKind = (typeof healthCourseKinds)[number];

/** FR-1. graduacao = estudante (graduação ou técnico); residente = residente ou pós; preparando = preparando prova. */
export const studySituations = ['graduacao', 'residente', 'profissional', 'preparando'] as const;
export const studySituationSchema = z.enum(studySituations);
export type StudySituation = z.infer<typeof studySituationSchema>;

/** FR-1: who wrote the row. `migration` = backfilled for accounts that existed before F35, not yet confirmed (FR-45). */
export const studyProfileSources = ['signup', 'profile', 'migration'] as const;
export type StudyProfileSource = (typeof studyProfileSources)[number];

/** FR-3. Official acronyms as written (content, seed/reference/councils.json). */
export const councilCodes = [
  'CRM', 'COREN', 'CRO', 'CRF', 'CREFITO', 'CRN', 'CRP', 'CRBM', 'CREFONO', 'CREF', 'CRESS', 'CRMV', 'CRBio', 'CRTR',
] as const;
export const councilCodeSchema = z.enum(councilCodes);
export type CouncilCode = z.infer<typeof councilCodeSchema>;

/** FR-5. Distinct from onboarding `goals` (profiles.goals, exam dates). */
export const studyGoalCodes = [
  'enamed', 'residencia_medica', 'revalida', 'provas_faculdade', 'provas_curso', 'concursos_saude', 'residencia_multiprofissional',
  'residencia_enfermagem', 'residencia_especializacao', 'enade', 'atualizacao_profissional', 'idiomas', 'aprender_por_conta',
] as const;
export const studyGoalCodeSchema = z.enum(studyGoalCodes);
export type StudyGoalCode = z.infer<typeof studyGoalCodeSchema>;

export const institutionTypes = ['public', 'private'] as const;
export type InstitutionType = (typeof institutionTypes)[number];

export const STUDY_PROFILE_LIMITS = {
  courseOther: 80, institutionText: 160, city: 80, nonHealthTopic: 80, customGoal: 60, customGoals: 3, councilNumber: 20,
} as const;

/** FR-15: accent/case-insensitive search key (institutions.search is stored with this; queries use it too). */
export const normalizeSearch = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const matchesSearch = (q: string, texts: readonly string[]) => {
  const n = normalizeSearch(q);
  return texts.some((t) => normalizeSearch(t).includes(n));
};

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

// --- capabilities (FR-7, D-096): one pure function, server and client -----------------------------------------------
export const starterTemplates = ['enamed', 'full_40', 'quick', 'mistakes', 'blank'] as const;
export type StarterTemplate = (typeof starterTemplates)[number];
export type SubjectSystem = 'enamed' | 'course_disciplines' | 'none';
export type ProfileCapabilities = {
  showEnamed: boolean;
  suggestedGoals: StudyGoalCode[];
  starterTemplates: StarterTemplate[];
  subjectSystem: SubjectSystem;
  needsConfirmation: boolean;
};
const GENERIC_GOALS: StudyGoalCode[] = ['provas_faculdade', 'idiomas', 'aprender_por_conta'];

/**
 * No row or source 'migration' (accounts from before F35, FR-45) = today's product unchanged (Enamed menu, ENAMED subjects and
 * preset) plus the "Confirme o seu estudo" prompt. Otherwise Enamed only for course medicine + situation graduacao.
 * `course` = the health_courses row of profile.course, when the caller has it (source of suggestedGoals).
 */
export function profileCapabilities(
  profile: Pick<StudyProfile, 'course' | 'situation' | 'source'> | null,
  course?: Pick<HealthCourse, 'suggestedGoals'> | null,
): ProfileCapabilities {
  const rest = ['quick', 'mistakes', 'blank'] as const;
  if (!profile || profile.source === 'migration' || !profile.course) {
    return { showEnamed: true, suggestedGoals: ['enamed'], starterTemplates: ['enamed', ...rest], subjectSystem: 'enamed', needsConfirmation: true };
  }
  const medicine = profile.course === 'medicine';
  const special = profile.course === 'other_health' || profile.course === 'not_health';
  return {
    showEnamed: medicine && profile.situation === 'graduacao',
    suggestedGoals: course?.suggestedGoals ?? (profile.course === 'not_health' ? GENERIC_GOALS : []),
    starterTemplates: [medicine ? 'enamed' : 'full_40', ...rest],
    subjectSystem: medicine ? 'enamed' : special ? 'none' : 'course_disciplines',
    needsConfirmation: false,
  };
}
