// G28-P / F35 (D-1864): zod-free core of the study profile. Client code imports this subpath ('@remoa/contracts/study-profile-core')
// so the menu, Hoje and the study form never pull zod and every schema of the contracts barrel into the browser bundle.
// study-profile.ts re-exports everything here; schemas stay there.

/** First 12 must equal healthProfessionCodes (CCR-150, health-taxonomy.ts) so the profile matches question classification. */
export const healthCourseCodes = [
  'medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy',
  'biomedicine', 'nutrition', 'speech_therapy', 'physical_education',
  'veterinary_medicine', 'occupational_therapy',
  'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health',
] as const;
export type HealthCourseCode = (typeof healthCourseCodes)[number];
/** `other_health` = "Outro curso da saúde" (free text), `not_health` = "Não é da área da saúde" (topic free text). */
export const healthCourseKinds = ['course', 'other_health', 'not_health'] as const;
export type HealthCourseKind = (typeof healthCourseKinds)[number];

/** FR-1. graduacao = estudante (graduação ou técnico); residente = residente ou pós; preparando = preparando prova. */
export const studySituations = ['graduacao', 'residente', 'profissional', 'preparando'] as const;
export type StudySituation = (typeof studySituations)[number];

/** FR-1: who wrote the row. `migration` = backfilled for accounts that existed before F35, not yet confirmed (FR-45). */
export const studyProfileSources = ['signup', 'profile', 'migration'] as const;
export type StudyProfileSource = (typeof studyProfileSources)[number];

/** FR-3. Official acronyms as written (content, seed/reference/councils.json). */
export const councilCodes = [
  'CRM', 'COREN', 'CRO', 'CRF', 'CREFITO', 'CRN', 'CRP', 'CRBM', 'CREFONO', 'CREF', 'CRESS', 'CRMV', 'CRBio', 'CRTR',
] as const;
export type CouncilCode = (typeof councilCodes)[number];

/** FR-5. Distinct from onboarding `goals` (profiles.goals, exam dates). */
export const studyGoalCodes = [
  'enamed', 'residencia_medica', 'revalida', 'provas_faculdade', 'provas_curso', 'concursos_saude', 'residencia_multiprofissional',
  'residencia_enfermagem', 'residencia_especializacao', 'enade', 'atualizacao_profissional', 'idiomas', 'aprender_por_conta',
] as const;
export type StudyGoalCode = (typeof studyGoalCodes)[number];

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
  profile: { course: HealthCourseCode | null; situation: StudySituation | null; source: StudyProfileSource } | null,
  course?: { suggestedGoals: StudyGoalCode[] } | null,
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
