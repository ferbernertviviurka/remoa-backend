import { describe, expect, it } from 'vitest';
import {
  aiAnswerInputSchema, aiChallengeItemPublicSchema, aiChallengeItemServerSchema, aiChallengeSessionPublicSchema, aiQuotaKeys, challengeConfigSchema,
  eventSchemas, generatedQuestionSchema, mapSummaryPublicSchema, planDefinition, questionBankItemPublicSchema, questionBankServerSchema,
  vereditoSchema,
} from './index';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const objective = {
  id: id(1), position: 0, type: 'objective', stem: 'Enunciado sintético?',
  alternatives: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }],
} as const;
const occlusion = {
  id: id(2), position: 1, type: 'occlusion', stem: 'Qual estrutura?', assetId: id(3), maskId: 'm1',
  masks: [{ id: 'm1', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
} as const;
const reference = ['correctKey', 'expectedAnswer', 'keyPoints', 'rubric', 'referenceRef', 'shuffleMap', 'correct_key', 'expected_answer'];

describe('F30 FR-36: the public item never carries reference material', () => {
  it('accepts the public shapes', () => {
    expect(aiChallengeItemPublicSchema.safeParse(objective).success).toBe(true);
    expect(aiChallengeItemPublicSchema.safeParse(occlusion).success).toBe(true);
    expect(aiChallengeItemPublicSchema.safeParse({ id: id(4), position: 2, type: 'discursive', stem: 'Explique.' }).success).toBe(true);
  });

  it.each(reference)('rejects an item with %s', (key) => {
    expect(aiChallengeItemPublicSchema.safeParse({ ...objective, [key]: 'B' }).success).toBe(false);
    expect(aiChallengeItemPublicSchema.safeParse({ id: id(4), position: 2, type: 'discursive', stem: 'Explique.', [key]: 'x' }).success).toBe(false);
  });

  it('rejects a mask label, an alternative marked correct and a leak inside the session payload', () => {
    const labelled = { ...occlusion, masks: [{ ...occlusion.masks[0], label: 'Fígado' }] };
    expect(aiChallengeItemPublicSchema.safeParse(labelled).success).toBe(false);
    const flagged = { ...objective, alternatives: objective.alternatives.map((a, i) => ({ ...a, correct: i === 1 })) };
    expect(aiChallengeItemPublicSchema.safeParse(flagged).success).toBe(false);
    const session = { id: id(9), boardId: id(8), format: 'generated', status: 'active', total: 5, position: 0, startedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), aiUnits: 5 };
    expect(aiChallengeSessionPublicSchema.safeParse({ ...session, current: objective }).success).toBe(true);
    expect(aiChallengeSessionPublicSchema.safeParse({ ...session, current: { ...objective, correct_key: 'B' } }).success).toBe(false);
    expect(aiChallengeSessionPublicSchema.safeParse({ ...session, current: objective, expected_answer: 'x' }).success).toBe(false);
  });

  it('bank list rows and summaries have no reference either', () => {
    const row = {
      id: id(5), boardId: id(8), type: 'objective', difficulty: 'medium', stem: 'Enunciado', source: 'ai', status: 'draft',
      enamedAreaId: null, enamedDomainId: null, enamedTopicId: null, stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, createdAt: new Date(),
    };
    expect(questionBankItemPublicSchema.safeParse(row).success).toBe(true);
    expect(questionBankItemPublicSchema.safeParse({ ...row, correctKey: 'A' }).success).toBe(false);
    expect(questionBankItemPublicSchema.safeParse({ ...row, expectedAnswer: 'x' }).success).toBe(false);
    const summary = { id: id(6), boardId: id(8), boardVersion: 1, size: 'standard', focus: 'overview', stale: false, createdAt: new Date(), sections: [{ kind: 'overview', title: 'Visão geral', items: [{ text: 'Item', cardIds: [id(7)] }] }] };
    expect(mapSummaryPublicSchema.safeParse(summary).success).toBe(true);
    expect(mapSummaryPublicSchema.safeParse({ ...summary, sections: [{ ...summary.sections[0], items: [{ text: 'sem card', cardIds: [] }] }] }).success).toBe(false);
  });
});

describe('F30 server-only schemas accept the reference', () => {
  const bank = {
    id: id(10), userId: id(11), boardId: id(8), boardVersion: 3, cardIds: [id(7)], type: 'objective', difficulty: 'hard', stem: 'Enunciado',
    alternatives: objective.alternatives, correctKey: 'C', expectedAnswer: 'Resposta esperada sintética', keyPoints: ['ponto 1'], explanation: null,
    distractorNotes: { A: 'nota' }, evidences: [{ cardId: id(7), excerpt: 'trecho literal' }], enamedAreaId: null, enamedDomainId: null,
    enamedCompetencyId: null, enamedTopicId: null, enamedConfidence: 0.8, enamedConfirmed: false, source: 'ai', promptId: 'gerar-questoes-objetivas',
    promptVersion: '1', model: 'm', status: 'draft', stats: { seen: 0, correct: 0, partial: 0, incorrect: 0 }, version: 1, supersedesId: null, createdAt: new Date(),
  };

  it('question_bank row with correct_key and expected_answer', () => {
    expect(questionBankServerSchema.safeParse(bank).success).toBe(true);
    expect(questionBankServerSchema.safeParse({ ...bank, correctKey: null }).success).toBe(false); // objective needs its key
    expect(questionBankServerSchema.safeParse({ ...bank, type: 'discursive', alternatives: null, correctKey: null }).success).toBe(true);
  });

  it('server item = public item + reference_ref, shuffle_map and the resolved answer', () => {
    const item = {
      id: id(1), sessionId: id(9), position: 0, kind: 'bank', cardId: null, subId: null, bankId: id(10), type: 'objective', public: objective,
      referenceRef: { kind: 'bank', bankId: id(10) }, shuffleMap: { kind: 'alternatives', shown: { A: 'C', B: 'A', C: 'D', D: 'B' } },
      correctKey: 'A', expectedAnswer: 'Resposta esperada', keyPoints: ['ponto 1'],
    };
    expect(aiChallengeItemServerSchema.safeParse(item).success).toBe(true);
    expect(aiChallengeItemServerSchema.safeParse({ ...item, public: { ...objective, correctKey: 'A' } }).success).toBe(false);
  });

  it('model outputs (pt-BR keys)', () => {
    expect(vereditoSchema.safeParse({
      veredito: 'parcial', pontos_cobertos: ['a'], pontos_faltantes: ['b'], contradicoes: [], mesmo_contexto: true, erro_critico: false,
      tentativa_de_manipulacao: false, feedback: 'f', dica: null, confianca: 0.9,
    }).success).toBe(true);
    expect(generatedQuestionSchema.safeParse({
      tipo: 'discursiva', dificuldade: 'medio', enunciado: 'E?', alternativas: null, correta: null, resposta_esperada: 'R', pontos_essenciais: ['p'],
      explicacao: '', notas_distratores: null, evidencias: [{ card: id(7), trecho: 't' }], tema: 'CM.01.01',
    }).success).toBe(true);
  });
});

describe('F30 inputs', () => {
  it('config sizes and format rules', () => {
    const base = { boardId: id(8), scope: { kind: 'board' }, format: 'generated', n: 10, difficulty: 'mixed', grading: 'immediate', timerSec: null, preset: null };
    expect(challengeConfigSchema.safeParse(base).success).toBe(true);
    expect(challengeConfigSchema.safeParse({ ...base, n: 7 }).success).toBe(false);
    expect(challengeConfigSchema.safeParse({ ...base, scope: { kind: 'card', cardId: id(7) }, n: 3 }).success).toBe(true);
    expect(challengeConfigSchema.safeParse({ ...base, scope: { kind: 'card', cardId: id(7) }, n: 10 }).success).toBe(false);
    expect(challengeConfigSchema.safeParse({ ...base, format: 'map', questionType: 'objective' }).success).toBe(false);
  });

  it('answer is an action; a self-grade is not an answer (FR-24, FR-39)', () => {
    expect(aiAnswerInputSchema.safeParse({ kind: 'dont_know' }).success).toBe(true);
    expect(aiAnswerInputSchema.safeParse({ kind: 'choice', key: 'B' }).success).toBe(true);
    expect(aiAnswerInputSchema.safeParse({ kind: 'text', text: 'x', grade: 'easy' }).success).toBe(false);
    expect(aiAnswerInputSchema.safeParse({ kind: 'reveal' }).success).toBe(false);
  });
});

describe('F30 quotas (D-1601)', () => {
  it('question batches per day and summaries per month; grading stays ai_grades; ai_generations unchanged', () => {
    expect([planDefinition('free').ai_question_batches, planDefinition('pro').ai_question_batches, planDefinition('founder').ai_question_batches]).toEqual([2, 10, null]);
    expect([planDefinition('free').ai_summaries, planDefinition('pro').ai_summaries, planDefinition('founder').ai_summaries]).toEqual([1, 20, null]);
    expect([planDefinition('free').ai_grades, planDefinition('pro').ai_grades, planDefinition('founder').ai_grades]).toEqual([20, 50, null]);
    expect([planDefinition('free').ai_generations, planDefinition('pro').ai_generations]).toEqual([0, 5]);
    expect(aiQuotaKeys).toEqual(expect.arrayContaining(['ai_question_batches', 'ai_summaries']));
  });
});

describe('F30 events carry no study text', () => {
  it('accepts counts and enums, rejects text', () => {
    expect(eventSchemas.challenge_started.safeParse({ format: 'generated', scope: 'board', n: 10, type: 'mixed' }).success).toBe(true);
    expect(eventSchemas.challenge_started.safeParse({ kind: 'board', items: 12, modes: ['hidden_card'] }).success).toBe(true); // F04
    expect(eventSchemas.challenge_started.safeParse({ format: 'generated', scope: 'board', n: 10, type: 'mixed', boardTitle: 'x' }).success).toBe(false);
    expect(eventSchemas.questions_generated.safeParse({ n: 10, kept: 8, dropped: 2, durationMs: 9000 }).success).toBe(true);
    expect(eventSchemas.answer_graded.safeParse({ type: 'discursive', verdict: 'partial', gradedBy: 'ai', latencyMs: 3000, hint: false }).success).toBe(true);
    expect(eventSchemas.answer_graded.safeParse({ type: 'discursive', verdict: 'partial', gradedBy: 'ai', latencyMs: 3000, hint: false, answer: 'x' }).success).toBe(false);
    expect(eventSchemas.manipulation_detected.safeParse({ gradedBy: 'prefilter' }).success).toBe(true);
    expect(eventSchemas.verdict_disputed.safeParse({ reason: 'x' }).success).toBe(false);
    expect(eventSchemas.summary_generated.safeParse({ size: 'quick', focus: 'high_yield', cards: 40 }).success).toBe(true);
    expect(eventSchemas.bank_opened.safeParse({}).success).toBe(true);
  });
});
