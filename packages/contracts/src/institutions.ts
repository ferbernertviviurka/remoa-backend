// G20 (F28, CCR-050): teaching institution. Static, versioned list of Brazilian medical schools in ./data/medical-schools.ts
// (content lane; source and date recorded there). Not medical content (rule 6 does not apply), but reference data.
import { z } from 'zod';
import type { BrUf } from './account';
import { MEDICAL_SCHOOLS as SCHOOLS } from './data/medical-schools';

// Type only (account.ts imports this module; no runtime cycle). data/medical-schools.test.ts validates the data.
export type MedicalSchool = {
  /** Stable slug (a-z, 0-9, hyphen); stored in profiles.school_id. Never reuse or rename an id. */
  id: string;
  /** 2–160 chars. */
  name: string;
  acronym?: string;
  city: string;
  uf: BrUf;
};

/** Validated (uf ∈ brUfs, unique slug ids) by data/medical-schools.test.ts. */
export const MEDICAL_SCHOOLS = SCHOOLS as readonly MedicalSchool[];
const byId = new Map<string, MedicalSchool>(MEDICAL_SCHOOLS.map((s) => [s.id, s]));
export const findMedicalSchool = (id: string): MedicalSchool | undefined => byId.get(id);

/**
 * PATCH /v1/account/profile `institution` (the only writer of profiles.school / school_id, D-843). `schoolId` must be in
 * MEDICAL_SCHOOLS; then `name` is replaced by the list's name. `schoolId: null` = "Outra instituição" (free text, 2–160).
 * Output is what the server stores: school = name, school_id = schoolId.
 */
export const institutionInputSchema = z
  .object({
    schoolId: z.string().max(64).nullable(),
    name: z.string().transform((s) => s.trim().replace(/\s+/g, ' ')).pipe(z.string().min(2).max(160)),
  })
  .strict()
  .transform((v, ctx) => {
    if (v.schoolId === null) return v;
    const school = byId.get(v.schoolId);
    if (!school) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown school', path: ['schoolId'] });
      return z.NEVER;
    }
    return { schoolId: school.id, name: school.name };
  });
export type InstitutionInput = z.input<typeof institutionInputSchema>;
