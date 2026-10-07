import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  AREA_OPTIONS, areas, boardSchema, cardSchema, contentReviewDecisionSchema, didacticsSchema, evidenceSchema, mapFileSchema, verifyResultSchema,
} from './index';

// docs/ lives in the remoa repo around remoa-backend; a standalone checkout (CI) skips the template tests (P-673).
const templateFile = fileURLToPath(new URL('../../../../docs/content/enamed/_template/mapa.yaml', import.meta.url));
const hasDocs = existsSync(templateFile);
const template = hasDocs ? parse(readFileSync(templateFile, 'utf8')) : null;

describe('F31 content contracts', () => {
  it.skipIf(!hasDocs)('docs/content/enamed/_template/mapa.yaml passes MapFile', () => {
    const r = mapFileSchema.safeParse(template);
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });

  it.skipIf(!hasDocs)('enforces shape limits and references', () => {
    const card = template.cards[0];
    const bad = (patch: object) => mapFileSchema.safeParse({ ...template, cards: [{ ...card, ...patch }] }).success;
    expect(bad({ frente: 'x'.repeat(181) })).toBe(false);
    expect(bad({ verso: Array(41).fill('palavra').join(' ') })).toBe(false);
    expect(bad({ verso: Array(7).fill('- item').join('\n') })).toBe(false);
    expect(bad({ preRequisitos: ['nao-existe'] })).toBe(false);
    expect(bad({ macete: { tipo: 'sigla', texto: 'RPP' } })).toBe(false); // explanation required
    expect(mapFileSchema.safeParse({ ...template, mapa: { ...template.mapa, status: 'seed_approved' } }).success).toBe(false);
    const flow = template.cards.find((c: { tipo: string }) => c.tipo === 'fluxograma');
    expect(mapFileSchema.safeParse({ ...template, cards: [{ ...flow, preRequisitos: [], passos: flow.passos.slice(0, 1) }], conexoes: [] }).success).toBe(false);
  });

  it('evidence, verify and review decision', () => {
    expect(evidenceSchema.safeParse({ cardId: 'sepse-m1-001', doc: 'sepsis-3', local: 'p. 2', trecho: Array(26).fill('a').join(' ') }).success).toBe(false);
    expect(verifyResultSchema.parse({ cardId: 'sepse-m1-001', veredito: 'sustenta', motivo: 'ok' }).veredito).toBe('sustenta');
    expect(contentReviewDecisionSchema.safeParse({ cardId: 'sepse-m1-001', decisao: 'ajustar' }).success).toBe(false);
    expect(contentReviewDecisionSchema.safeParse({ cardId: 'sepse-m1-001', decisao: 'aprovo' }).success).toBe(true);
  });

  it('output Card/Board accept the new fields and stay backward compatible', () => {
    const d = didacticsSchema.parse({ nivel: 2, modulo: 'M3', risco: 'conduta', naDiretriz: { texto: 't', data: '2026-03-23' } });
    expect(cardSchema.shape.didactics.parse(d)).toEqual(d);
    expect(cardSchema.shape.pathOrder.parse(undefined)).toBeUndefined();
    expect(boardSchema.shape.badges.parse(['top10_enamed'])).toEqual(['top10_enamed']);
    expect(boardSchema.shape.badges.safeParse(['outro']).success).toBe(false);
  });

  it('CCR-083: OUTRO is an area but not an onboarding option', () => {
    expect(areas).toContain('OUTRO');
    expect(AREA_OPTIONS.map((a) => a.id)).not.toContain('OUTRO');
  });
});
