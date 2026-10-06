// G20 contracts (F28, CCR-050): required name/phone, institution, `not_med`.
import { describe, expect, it } from 'vitest';
import {
  institutionInputSchema, missingRequiredProfile, onboardingAnswersPatchSchema, profileSchema,
  segments, signUpInputSchema, updateProfileInputSchema,
} from './index';
import { MEDICAL_SCHOOLS, findMedicalSchool } from './medical-schools';

const school = MEDICAL_SCHOOLS[0]!;

describe('G20 cadastro', () => {
  it('sign-up requires a valid name (nameSchema)', () => {
    const base = { email: 'a@b.co', password: '12345678a' };
    expect(signUpInputSchema.safeParse(base).success).toBe(false);
    expect(signUpInputSchema.safeParse({ ...base, name: 'A' }).success).toBe(false);
    expect(signUpInputSchema.parse({ ...base, name: '  Ana   Souza ' }).name).toBe('Ana Souza');
  });

  it('profile update: name cannot be cleared; phone replaced, never cleared', () => {
    expect(updateProfileInputSchema.safeParse({ name: null }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateProfileInputSchema.safeParse({ phone: null }).success).toBe(false);
    expect(updateProfileInputSchema.parse({ phone: '(11) 91234-5678' }).phone).toBe('+5511912345678');
  });

  it('missingRequiredProfile lists name, phone and userType in that order', () => {
    expect(missingRequiredProfile({ name: null, phone: null, userType: null })).toEqual(['name', 'phone', 'userType']);
    expect(missingRequiredProfile({ name: 'A1', phone: '+55119', userType: 'aluno' })).toEqual(['name', 'phone']);
    expect(missingRequiredProfile({ name: 'Ana', phone: '+5511912345678', userType: 'aluno' })).toEqual([]);
  });

  it('not_med is the last segment and valid in onboarding and profile stage', () => {
    expect(segments.at(-1)).toBe('not_med');
    expect(onboardingAnswersPatchSchema.safeParse({ segment: 'not_med' }).success).toBe(true);
    expect(updateProfileInputSchema.safeParse({ stage: 'not_med' }).success).toBe(true);
  });
});

describe('G20 institution', () => {
  it('list id → canonical name; unknown id refused; free text trimmed 2–160; null clears', () => {
    expect(findMedicalSchool(school.id)).toBe(school);
    expect(institutionInputSchema.parse({ schoolId: school.id, name: 'qualquer' })).toEqual({ schoolId: school.id, name: school.name });
    expect(institutionInputSchema.safeParse({ schoolId: 'nao-existe', name: 'X Y' }).success).toBe(false);
    expect(institutionInputSchema.parse({ schoolId: null, name: '  Faculdade   Livre ' })).toEqual({ schoolId: null, name: 'Faculdade Livre' });
    expect(institutionInputSchema.safeParse({ schoolId: null, name: 'X' }).success).toBe(false);
    expect(institutionInputSchema.safeParse({ schoolId: null, name: 'x'.repeat(161) }).success).toBe(false);
    expect(institutionInputSchema.safeParse({ schoolId: null, name: 'Ok', extra: 1 }).success).toBe(false);
    expect(updateProfileInputSchema.parse({ institution: null })).toEqual({ institution: null });
    expect(updateProfileInputSchema.parse({ institution: { schoolId: school.id, name: 'nome antigo' } }).institution).toEqual({ schoolId: school.id, name: school.name });
  });

  it('profile exposes school and schoolId', () => {
    expect(profileSchema.shape.school.parse(null)).toBeNull();
    expect(profileSchema.shape.schoolId.parse(school.id)).toBe(school.id);
  });
});
