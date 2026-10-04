import { describe, expect, it } from 'vitest';
import { isUntouchedStubSeed } from './stub-board';

const title = 'Sepse e choque séptico';

describe('isUntouchedStubSeed', () => {
  it('recognizes the keyword stubs and the overlay cards, and stops when a card was reviewed', () => {
    const stubs = [
      { title: 'Hiperglicemia: definição', status: 'draft' },
      { title: 'Hiperglicemia: conduta', status: 'draft' },
      { title: 'Hiperglicemia: o que não esquecer', status: 'draft' },
      { title: `Conduta de ${title}`, status: 'draft' },
      { title: `Reavaliação de ${title}`, status: 'draft' },
      { title: `Caso de ${title}`, status: 'draft' },
    ];
    expect(isUntouchedStubSeed(title, stubs)).toBe(true);
    expect(isUntouchedStubSeed(title, [...stubs, { title: 'Disfunção orgânica', status: 'draft' }])).toBe(false);
    expect(isUntouchedStubSeed(title, [{ title: 'Hiperglicemia: definição', status: 'approved' }])).toBe(false);
    expect(isUntouchedStubSeed(title, [])).toBe(false);
  });
});
