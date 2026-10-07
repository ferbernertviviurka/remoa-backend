import { describe, expect, it } from 'vitest';
import { boardHasEnamedCoverage } from './matrix';

describe('boardHasEnamedCoverage', () => {
  it('is true for trail slugs and ENAMED marks', () => {
    expect(boardHasEnamedCoverage({ path: { slug: 'sepse' } })).toBe(true);
    expect(boardHasEnamedCoverage({ temporalMark: 'ENAMED 2026' })).toBe(true);
    expect(boardHasEnamedCoverage({ badges: ['top10_enamed'] })).toBe(true);
  });
  it('is false for a plain private map', () => {
    expect(boardHasEnamedCoverage({ path: null, temporalMark: 'Aula 3', badges: [] })).toBe(false);
  });
});
