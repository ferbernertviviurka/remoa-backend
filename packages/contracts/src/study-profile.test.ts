import { describe, expect, it } from 'vitest';
import {
  healthCourseCodes, institutionsQuerySchema, matchesSearch, normalizeSearch, profileCapabilities, studyProfileInputSchema,
  studySituations, type HealthCourseCode, type StudyProfile,
} from './index';

const P = (course: HealthCourseCode | null, situation: StudyProfile['situation'], source: StudyProfile['source']) => ({ course, situation, source });

describe('profileCapabilities (FR-7, D-096)', () => {
  const courses = ['medicine', 'nursing', 'other_health', 'not_health'] as const;
  const rows = studySituations.flatMap((s) => courses.flatMap((c) => (['signup', 'profile', 'migration'] as const).map((src) => [s, c, src] as const)));

  it.each(rows)('%s × %s × %s', (situation, course, source) => {
    const cap = profileCapabilities(P(course, situation, source));
    if (source === 'migration') {
      expect(cap).toEqual({ showEnamed: true, suggestedGoals: ['enamed'], starterTemplates: ['enamed', 'quick', 'mistakes', 'blank'], subjectSystem: 'enamed', needsConfirmation: true });
      return;
    }
    expect(cap.showEnamed).toBe(course === 'medicine' && situation === 'graduacao');
    expect(cap.needsConfirmation).toBe(false);
    expect(cap.starterTemplates[0]).toBe(course === 'medicine' ? 'enamed' : 'full_40');
    expect(cap.subjectSystem).toBe({ medicine: 'enamed', nursing: 'course_disciplines', other_health: 'none', not_health: 'none' }[course]);
  });

  it('no row = migration; migration row without course keeps today menu', () => {
    expect(profileCapabilities(null)).toEqual(profileCapabilities(P(null, null, 'migration')));
    expect(profileCapabilities(null).showEnamed).toBe(true);
  });

  it('suggested goals come from the course row; not_health falls back to generic goals', () => {
    expect(profileCapabilities(P('nursing', 'graduacao', 'profile'), { suggestedGoals: ['residencia_enfermagem'] }).suggestedGoals).toEqual(['residencia_enfermagem']);
    expect(profileCapabilities(P('nursing', 'graduacao', 'profile')).suggestedGoals).toEqual([]);
    expect(profileCapabilities(P('not_health', 'preparando', 'signup')).suggestedGoals).toEqual(['provas_faculdade', 'idiomas', 'aprender_por_conta']);
  });
});

describe('normalizeSearch (FR-15)', () => {
  it('strips accents, case and extra spaces', () => {
    expect(normalizeSearch('  Farmácia   e  BIOQUÍMICA ')).toBe('farmacia e bioquimica');
    expect(matchesSearch('farmacia', ['Farmácia'])).toBe(true);
    expect(matchesSearch('tecnico', ['Técnico(a) em Enfermagem'])).toBe(true);
    expect(matchesSearch('UFPR', ['Universidade Federal do Paraná', 'ufpr'])).toBe(true);
    expect(matchesSearch('odonto', ['Farmácia'])).toBe(false);
  });
});

describe('studyProfileInputSchema', () => {
  const ok = { situation: 'graduacao', course: 'nursing', goals: ['provas_curso'] } as const;
  const fails = (v: object) => !studyProfileInputSchema.safeParse(v).success;

  it('course and at least one goal (own goal counts)', () => {
    expect(studyProfileInputSchema.parse({ ...ok, goals: ['enade', 'enade'] }).goals).toEqual(['enade']);
    expect(fails({ ...ok, goals: [] })).toBe(true);
    expect(fails({ ...ok, goals: [], customGoals: ['Prova de Farmacologia'] })).toBe(false);
    expect(fails({ situation: 'graduacao', goals: ['enade'] })).toBe(true);
  });
  it('period only for health students, 1..12', () => {
    expect(fails({ ...ok, period: 5 })).toBe(false);
    expect(fails({ ...ok, period: 13 })).toBe(true);
    expect(fails({ ...ok, situation: 'profissional', period: 5 })).toBe(true);
    expect(fails({ ...ok, course: 'not_health', nonHealthTopic: 'Direito', period: 5 })).toBe(true);
  });
  it('council number only for profissional, bounded', () => {
    expect(fails({ ...ok, situation: 'profissional', councilNumber: 'SP-123456' })).toBe(false);
    expect(fails({ ...ok, councilNumber: '123' })).toBe(true);
    expect(fails({ ...ok, situation: 'profissional', councilNumber: '1'.repeat(21) })).toBe(true);
    expect(fails({ ...ok, situation: 'profissional', councilNumber: '<script>' })).toBe(true);
  });
  it('free text iff other_health / not_health; institution id xor text; strict', () => {
    expect(fails({ ...ok, course: 'other_health' })).toBe(true);
    expect(fails({ ...ok, course: 'other_health', courseOtherText: '  Gestão   hospitalar ' })).toBe(false);
    expect(fails({ ...ok, courseOtherText: 'x y' })).toBe(true);
    expect(fails({ ...ok, course: 'not_health' })).toBe(true);
    expect(fails({ ...ok, nonHealthTopic: 'Direito' })).toBe(true);
    expect(fails({ ...ok, institutionId: '00000000-0000-4000-8000-000000000000', institutionText: 'Outra' })).toBe(true);
    expect(fails({ ...ok, institutionText: 'x'.repeat(161) })).toBe(true);
    expect(fails({ ...ok, source: 'migration' })).toBe(true);
  });
  it('every course code is unique', () => {
    expect(new Set(healthCourseCodes).size).toBe(healthCourseCodes.length);
  });
});

describe('institutionsQuerySchema', () => {
  it('q ≥ 2 chars, limit ≤ 20', () => {
    expect(institutionsQuerySchema.parse({ q: ' uf ' })).toEqual({ q: 'uf', limit: 10 });
    expect(institutionsQuerySchema.parse({ q: 'u' })).toEqual({ q: 'u', limit: 10 });
    expect(institutionsQuerySchema.parse({})).toEqual({ q: '', limit: 10 });
    expect(institutionsQuerySchema.safeParse({ q: 'x'.repeat(81) }).success).toBe(false);
    expect(institutionsQuerySchema.safeParse({ q: 'ufpr', limit: '21' }).success).toBe(false);
  });
});
