import { describe, expect, it } from 'vitest';
import { MEDICAL_SCHOOLS } from './medical-schools';

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

describe('MEDICAL_SCHOOLS', () => {
  it('tem pelo menos 398 entradas', () => expect(MEDICAL_SCHOOLS.length).toBeGreaterThanOrEqual(398));
  it('ids únicos e em slug', () => {
    const ids = MEDICAL_SCHOOLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('UF válida, campos não vazios', () => {
    for (const s of MEDICAL_SCHOOLS) {
      expect(UFS).toContain(s.uf);
      expect(s.name.trim()).not.toBe('');
      expect(s.city.trim()).not.toBe('');
      if (s.acronym !== undefined) expect(s.acronym.trim()).not.toBe('');
    }
  });
  it('ordenada por uf e depois por nome', () => {
    const k = MEDICAL_SCHOOLS.map((s) => `${s.uf}\u0000${s.name}`);
    const sorted = [...MEDICAL_SCHOOLS].sort((a, b) => a.uf.localeCompare(b.uf) || a.name.localeCompare(b.name, 'pt-BR'));
    expect(MEDICAL_SCHOOLS).toEqual(sorted);
    expect(k.length).toBe(MEDICAL_SCHOOLS.length);
  });
});
