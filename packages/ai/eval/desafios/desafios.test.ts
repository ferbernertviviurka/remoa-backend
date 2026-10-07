import { describe, expect, it } from 'vitest';
import { generationFixtures } from './generation';
import { gradingCases } from './grading';
import { GATES, gradeCase, runChallengeEval, runGeneration, runGrading, runSummary } from './run';
import { summaryFixtures } from './summary';

describe('bateria offline de desafios (FR-58)', () => {
  it('has the size and mix the FRD asks for', () => {
    expect(gradingCases).toHaveLength(40);
    expect(new Set(gradingCases.map((c) => c.id)).size).toBe(40);
    for (const tipo of ['outras_palavras', 'parcial', 'incorreta', 'contexto_errado', 'erro_critico', 'injecao', 'vazia', 'nao_sei'] as const) {
      expect(gradingCases.some((c) => c.tipo === tipo), tipo).toBe(true);
    }
    const flawedCorreta = gradingCases.filter((c) => c.modelo.veredito === 'correta' && (c.modelo.pontos_faltantes.length || c.modelo.contradicoes.length));
    expect(flawedCorreta.length).toBeGreaterThanOrEqual(8);
    expect(flawedCorreta.every((c) => c.esperado !== 'correta')).toBe(true);
    expect(generationFixtures).toHaveLength(10);
    expect(generationFixtures.every((m) => Object.keys(m.cards).length === 3)).toBe(true);
    expect(summaryFixtures).toHaveLength(6);
  });

  it.each(gradingCases)('$id ($tipo) ends as $esperado after the guards', (c) => {
    const r = gradeCase(c);
    expect(r.veredito).toBe(c.esperado);
    expect(r.filtro).toBe(c.filtro ?? null);
    expect(r.scrubbed).toBe(Boolean(c.vaza));
    expect(r.leakRemains).toBe(false);
    if (c.tipo === 'injecao') expect(r).toMatchObject({ veredito: 'incorreta', manipulation: true });
  });

  it('agrees with the human label on at least 90%, with 0 leaks and 0 obeyed injections', () => {
    const g = runGrading();
    expect(g.agreement).toBeGreaterThanOrEqual(GATES.agreement);
    expect(g.disagreements).toEqual(['g24', 'g40']);
    expect(g.leaksRemaining).toEqual([]);
    expect(g.injectionsObeyed).toEqual([]);
    expect(g.injections).toBe(6);
    expect(g.leaksScrubbed).toBeGreaterThanOrEqual(1);
  });

  it('discards generated questions with a non-literal quote or an ungrounded number', () => {
    const g = runGeneration();
    expect(g.regressions).toEqual([]);
    expect(g).toMatchObject({ questions: 30, claimed: 30, verified: 29, kept: 27, discarded: { evidence: 1, numbers: 2 } });
    expect(g.evidenceRate).toBeGreaterThanOrEqual(GATES.evidence);
  });

  it('drops summary items with no known card or an ungrounded number', () => {
    const s = runSummary();
    expect(s.regressions).toEqual([]);
    expect(s.discarded.citation).toBeGreaterThanOrEqual(1);
    expect(s.discarded.numbers).toBeGreaterThanOrEqual(1);
  });

  it('passes every gate', () => {
    const report = runChallengeEval();
    expect(report.gates).toEqual({ agreement: true, leak: true, injection: true, evidence: true, fixtures: true });
    expect(report.ok).toBe(true);
  });
});
