import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError, generateJson } from '@remoa/ai';
import { questionBankServerSchema, type ChallengeScope, type QuestionBankServer } from '@remoa/contracts';
import { refundAt, reserveAi } from '../billing/quota';
import {
  checkedDifficulty, generateQuestions, scopeCardIds, serializeMap, toRow, type GenerateDeps, type GenerateInput, type MapContext, type QuestionStore,
} from './generate';

vi.mock('@remoa/ai', async (orig) => ({ ...(await orig<typeof import('@remoa/ai')>()), generateJson: vi.fn() }));
vi.mock('../billing/quota', () => ({ reserveAi: vi.fn(), refundAt: vi.fn() }));

const ask = vi.mocked(generateJson);
const reserve = vi.mocked(reserveAi);
const refund = vi.mocked(refundAt);

const USER = '44444444-4444-4444-8444-444444444444';
const BOARD = '55555555-5555-4555-8555-555555555555';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const AREA = '66666666-6666-4666-8666-666666666666';
const DOMAIN = '77777777-7777-4777-8777-777777777777';
const PERIOD = '2026-10-07';

// Synthetic clinical-style text for the guards; not reference material.
const card = (id: string, title: string, front: string, back: string) => ({ id, type: 'concept', title, front, back, payload: {}, didactics: null });
const CARDS = [
  card(C1, 'Definição sintética', 'O que define a síndrome sintética X?', 'Disfunção orgânica causada por resposta desregulada à infecção sintética.'),
  card(C2, 'Tempo do antimicrobiano', 'Quando iniciar o antimicrobiano na síndrome X?', 'Imediatamente, idealmente em até 1 hora do reconhecimento.'),
  card(C3, 'Alvo pressórico', 'Qual o alvo pressórico na síndrome X com vasopressor?', 'PAM ≥ 65 mmHg com o vasopressor alfa como primeira escolha.'),
];
const ctx = (over: Partial<MapContext> = {}): MapContext => ({
  boardId: BOARD, boardVersion: 3, title: 'Síndrome sintética X', area: 'CM', cards: CARDS, edges: [{ fromCardId: C1, toCardId: C2, label: 'leva a' }],
  tags: { areaId: AREA, domainId: DOMAIN, competencyId: null, topicId: null }, topicName: null, ...over,
});

type Disc = { enunciado: string; resposta_esperada: string; pontos_essenciais: string[]; explicacao: string; dificuldade: string; cards: string[]; evidencias: { card: string; trecho: string }[] };
const disc = (over: Partial<Disc> = {}): Disc => ({
  enunciado: 'Em quanto tempo o antimicrobiano deve começar depois do reconhecimento da síndrome X?',
  resposta_esperada: 'Imediatamente, idealmente em até 1 hora.',
  pontos_essenciais: ['início imediato', 'até 1 hora do reconhecimento'],
  explicacao: 'O card diz que o início é imediato, idealmente em até 1 hora.',
  dificuldade: 'facil', cards: ['c2'], evidencias: [{ card: 'c2', trecho: 'Imediatamente, idealmente em até 1 hora do reconhecimento.' }],
  ...over,
});
const obj = (over: Record<string, unknown> = {}) => ({
  enunciado: 'Paciente com síndrome X e hipotensão em uso de vasopressor. Qual o alvo pressórico?',
  alternativas: { A: 'PAM ≥ 50 mmHg', B: 'PAM ≥ 65 mmHg', C: 'PAM ≥ 90 mmHg', D: 'Sem alvo definido' },
  correta: 'B', explicacao_correta: 'O alvo é PAM ≥ 65 mmHg.', explicacao_distratores: { A: 'Baixo demais.', C: 'Alto demais.', D: 'Há alvo no card.' },
  dificuldade: 'facil', cards: ['c3'], evidencias: [{ card: 'c3', trecho: 'PAM ≥ 65 mmHg' }], tema_enamed_sugerido: 'alvo pressórico',
  ...over,
});
const reply = (data: unknown) => ({ data, text: '', model: 'test/model', tokensIn: 10, tokensOut: 20, latencyMs: 5, attempts: 1, fallback: false, billable: true as const, repaired: false });
const discReply = (...perguntas: Disc[]) => reply({ perguntas, aviso: null });
const objReply = (...questoes: ReturnType<typeof obj>[]) => reply({ questoes, aviso: null });

function memStore(over: { unseen?: QuestionBankServer[]; stems?: string[]; context?: MapContext | null } = {}) {
  const saved: QuestionBankServer[] = [];
  const store: QuestionStore = {
    context: vi.fn(async () => (over.context === undefined ? ctx() : over.context)),
    unseen: vi.fn(async (_u, _b, _ids, type, _d, limit) => (over.unseen ?? []).filter((q) => q.type === type).slice(0, limit)),
    stems: vi.fn(async () => [...(over.stems ?? []), ...saved.map((q) => q.stem)]),
    recentStems: vi.fn(async () => over.stems ?? []),
    save: vi.fn(async (_u, rows) => void saved.push(...rows)),
  };
  return { store, saved };
}
let ids = 0;
const deps = (store: QuestionStore): GenerateDeps => ({ store, now: () => new Date('2026-10-07T13:00:00Z'), newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` });
const input = (over: Partial<GenerateInput> = {}): GenerateInput => ({ userId: USER, boardId: BOARD, scope: { kind: 'board' }, n: 1, questionType: 'discursive', difficulty: 'mixed', ...over });
const systemOf = (call: number) => (ask.mock.calls[call]?.[1] as { system: string }).system;

beforeEach(() => {
  vi.clearAllMocks();
  reserve.mockResolvedValue({ ok: true, quota: { key: 'ai_question_batches', used: 1, limit: 5, period: PERIOD, remaining: 4, nearLimit: false }, refund: vi.fn() });
  refund.mockResolvedValue(undefined);
});

describe('generateQuestions: server guards', () => {
  it('discards a question whose evidence is not a literal copy of the cited card, then retries once', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc(), disc({ enunciado: 'Pergunta parafraseada sobre a definição?', dificuldade: 'facil', cards: ['c1'], evidencias: [{ card: 'c1', trecho: 'disfunção de órgãos por infecção' }] })))
      .mockResolvedValueOnce(discReply());
    const r = await generateQuestions(input({ n: 2 }), deps(store));
    expect(r.ok && r.data).toMatchObject({ generated: 1, shortfall: 1, calls: 2, discarded: { evidence: 1 } });
    expect(saved.map((q) => q.stem)).toEqual([disc().enunciado]);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled(); // the call answered: the batch is spent
  });

  it('discards citations of cards outside the scope and accepts quotes wrapped in quotes and odd spacing', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(
      disc({ cards: ['c9'], evidencias: [{ card: 'c9', trecho: 'Imediatamente' }] }),
      disc({ evidencias: [{ card: 'c2', trecho: '"imediatamente,   idealmente em até 1 hora"' }] }),
    ));
    const r = await generateQuestions(input({ n: 1 }), deps(store));
    expect(r.ok && r.data.discarded.evidence).toBe(1);
    expect(saved).toHaveLength(1);
  });

  it('discards a question with a number or dose not written in the cited cards', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc({ resposta_esperada: 'Imediatamente, idealmente em até 3 horas.' }), disc({ enunciado: 'Qual o alvo de PAM com vasopressor na síndrome X?', resposta_esperada: 'PAM ≥ 70 mmHg.', pontos_essenciais: ['PAM ≥ 70 mmHg'], explicacao: '', cards: ['c3'], evidencias: [{ card: 'c3', trecho: 'PAM ≥ 65 mmHg' }] })))
      .mockResolvedValueOnce(discReply(disc()));
    const r = await generateQuestions(input({ n: 1 }), deps(store));
    expect(r.ok && r.data.discarded.numbers).toBe(2);
    expect(saved.map((q) => q.expectedAnswer)).toEqual([disc().resposta_esperada]);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('discards duplicates of the map stems and inside the batch (similarity ≥ GEN_DUP_THRESHOLD)', async () => {
    const existing = 'Em quanto tempo o antimicrobiano deve começar depois do reconhecimento da síndrome X?';
    const { store, saved } = memStore({ stems: [existing] });
    const fresh = disc({ enunciado: 'Que alvo de pressão arterial média se busca com o vasopressor?', resposta_esperada: 'PAM ≥ 65 mmHg.', pontos_essenciais: ['PAM ≥ 65 mmHg'], explicacao: '', cards: ['c3'], evidencias: [{ card: 'c3', trecho: 'PAM ≥ 65 mmHg' }] });
    ask.mockResolvedValueOnce(discReply(disc({ enunciado: `${existing} ` }), fresh, { ...fresh, enunciado: `${fresh.enunciado}!` }));
    ask.mockResolvedValueOnce(discReply());
    const r = await generateQuestions(input({ n: 2 }), deps(store));
    expect(r.ok && r.data.discarded.duplicate).toBe(2);
    expect(saved.map((q) => q.stem)).toEqual([fresh.enunciado]);
    expect(systemOf(1)).toContain(`- ${fresh.enunciado}`); // the retry is told about the one already kept
  });

  it('retries at most once per batch and returns what remains with the shortfall', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValue(discReply(disc({ evidencias: [{ card: 'c2', trecho: 'texto que não está no card' }] })));
    const r = await generateQuestions(input({ n: 3 }), deps(store));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(r.ok && r.data).toMatchObject({ generated: 0, shortfall: 3, calls: 2 });
    expect(saved).toHaveLength(0);
    expect(refund).not.toHaveBeenCalled();
  });

  it('reclassifies difficulty by the number of cited cards instead of dropping', async () => {
    expect(checkedDifficulty('easy', 1)).toBe('easy');
    expect(checkedDifficulty('easy', 2)).toBe('medium');
    expect(checkedDifficulty('easy', 3)).toBe('hard');
    expect(checkedDifficulty('medium', 2)).toBe('medium');
    expect(checkedDifficulty('medium', 4)).toBe('hard');
    expect(checkedDifficulty('hard', 1)).toBe('medium');
    expect(checkedDifficulty('hard', 2)).toBe('hard');
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc({ dificuldade: 'difícil' })));
    await generateQuestions(input({ n: 1 }), deps(store));
    expect(saved[0]?.difficulty).toBe('medium');
  });
});

describe('generateQuestions: reuse and batches', () => {
  const bank = (i: number) => toRow(
    { question: { tipo: 'discursiva', dificuldade: 'facil', enunciado: `Pergunta salva ${i}?`, alternativas: null, correta: null, resposta_esperada: 'Imediatamente.', pontos_essenciais: ['imediato'], explicacao: '', notas_distratores: null, evidencias: [{ card: C2, trecho: 'Imediatamente' }], tema: null }, cardIds: [C2], difficulty: 'easy' },
    { id: `00000000-0000-4000-9000-00000000000${i}`, userId: USER, ctx: ctx(), prompt: { meta: { id: 'gerar-perguntas-discursivas', version: 1, variaveis: [], marcadores: [], dados: [], temperatura: 0.4 }, body: '', promptVersion: 'desafios/gerar-perguntas-discursivas@v1' }, model: 'test/model', seed: 's', now: new Date() },
  );

  it('reuses unseen saved questions without reserving or calling the model', async () => {
    const { store } = memStore({ unseen: [bank(1), bank(2)] });
    const r = await generateQuestions(input({ n: 2 }), deps(store));
    expect(r.ok && r.data).toMatchObject({ reused: 2, generated: 0, shortfall: 0, calls: 0 });
    expect(ask).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('asks the model only for the shortfall, with the map as data and the last saved stems', async () => {
    const { store } = memStore({ unseen: [bank(1)], stems: ['Pergunta antiga sobre o alvo?'] });
    ask.mockResolvedValueOnce(discReply(disc(), disc({ enunciado: 'O que caracteriza a síndrome sintética X?', resposta_esperada: 'Disfunção orgânica por resposta desregulada.', pontos_essenciais: ['disfunção orgânica'], explicacao: '', cards: ['c1'], evidencias: [{ card: 'c1', trecho: 'Disfunção orgânica causada por resposta desregulada' }] })));
    const r = await generateQuestions(input({ n: 3 }), deps(store));
    expect(r.ok && r.data).toMatchObject({ reused: 1, generated: 2, shortfall: 0, calls: 1 });
    expect(r.ok && r.data.questions[0]?.id).toBe(bank(1).id);
    const system = systemOf(0);
    expect(system).toContain('Crie 2 perguntas');
    expect(system).toMatch(/<mapa>\ntitulo: Síndrome sintética X[\s\S]*\[c2\] tipo=conceito[\s\S]*\[e1\] c1 --leva a--> c2\n<\/mapa>/);
    expect(system).toContain('- Pergunta antiga sobre o alvo?');
    expect(ask.mock.calls[0]?.[1]).toMatchObject({ fn: 'generate', temperature: 0.4 });
  });

  it('one generateJson call per batch of at most GEN_BATCH_SIZE, one unit each', async () => {
    vi.stubEnv('GEN_BATCH_SIZE', '2');
    try {
      const { store } = memStore();
      const q = (i: number) => disc({ enunciado: `${['Quando', 'Em que momento', 'Qual o prazo para', 'Até quando'][i]} iniciar o antimicrobiano na síndrome X (${['urgência', 'enfermaria', 'UTI', 'ambulatório'][i]})?` });
      ask.mockResolvedValueOnce(discReply(q(0), q(1))).mockResolvedValueOnce(discReply(q(2), q(3)));
      const r = await generateQuestions(input({ n: 4 }), deps(store));
      expect(ask).toHaveBeenCalledTimes(2);
      expect(systemOf(0)).toContain('Crie 2 perguntas');
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(r.ok && r.data.generated).toBe(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('saves drafts with prompt id/version, model, inherited ENAMED tags and topic left unconfirmed', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc()));
    await generateQuestions(input(), deps(store));
    const row = questionBankServerSchema.parse(saved[0]);
    expect(row).toMatchObject({
      status: 'draft', source: 'ai', promptId: 'gerar-perguntas-discursivas', promptVersion: 'desafios/gerar-perguntas-discursivas@v1', model: 'test/model',
      boardVersion: 3, cardIds: [C2], enamedAreaId: AREA, enamedDomainId: DOMAIN, enamedTopicId: null, enamedConfirmed: false, enamedConfidence: null,
      evidences: [{ cardId: C2, excerpt: 'Imediatamente, idealmente em até 1 hora do reconhecimento.' }],
    });
  });

  it('a topic inherited from the map is confirmed', async () => {
    const topic = '88888888-8888-4888-8888-888888888888';
    const { store, saved } = memStore({ context: ctx({ tags: { areaId: AREA, domainId: DOMAIN, competencyId: null, topicId: topic }, topicName: 'Tema sintético' }) });
    ask.mockResolvedValueOnce(discReply(disc()));
    await generateQuestions(input(), deps(store));
    expect(saved[0]).toMatchObject({ enamedTopicId: topic, enamedConfirmed: true });
    expect(systemOf(0)).toContain('tema: Tema sintético');
  });

  it('mixed type splits the count between discursive and objective prompts', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc())).mockResolvedValueOnce(objReply(obj()));
    await generateQuestions(input({ n: 2, questionType: 'mixed' }), deps(store));
    expect(systemOf(0)).toContain('Crie 1 perguntas abertas');
    expect(systemOf(1)).toContain('Crie 1 questões de múltipla escolha');
    expect(saved.map((q) => q.type)).toEqual(['discursive', 'objective']);
  });

  it('not_found for a board that is not the user’s; validation for an empty scope', async () => {
    expect(await generateQuestions(input(), deps(memStore({ context: null }).store))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await generateQuestions(input(), deps(memStore({ context: ctx({ cards: [] }) }).store))).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
});

describe('generateQuestions: quota and refund', () => {
  it('gives the unit back with refundAt when the model call fails', async () => {
    const { store, saved } = memStore();
    ask.mockRejectedValueOnce(new AiError('provider_error'));
    const r = await generateQuestions(input(), deps(store));
    expect(r).toMatchObject({ ok: false, error: { code: 'ai_unavailable' } });
    expect(refund).toHaveBeenCalledExactlyOnceWith(USER, 'ai_question_batches', PERIOD);
    expect(saved).toHaveLength(0);
  });

  it('a failed retry keeps the unit and the questions of the first call', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(discReply(disc())).mockRejectedValueOnce(new AiError('timeout'));
    const r = await generateQuestions(input({ n: 2 }), deps(store));
    expect(r.ok && r.data).toMatchObject({ generated: 1, shortfall: 1, stoppedBy: null });
    expect(saved).toHaveLength(1);
    expect(refund).not.toHaveBeenCalled();
  });

  it('gives the unit back when saving throws, and rethrows', async () => {
    const { store } = memStore();
    vi.mocked(store.save).mockRejectedValueOnce(new Error('db down'));
    ask.mockResolvedValueOnce(discReply(disc()));
    await expect(generateQuestions(input(), deps(store))).rejects.toThrow('db down');
    expect(refund).toHaveBeenCalledExactlyOnceWith(USER, 'ai_question_batches', PERIOD);
  });

  it('no unit left: no model call, quota error when nothing was reused', async () => {
    reserve.mockResolvedValueOnce({ ok: false, error: { code: 'quota_exceeded', message: 'ai_question_batches' } });
    const r = await generateQuestions(input(), deps(memStore().store));
    expect(r).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('objective questions', () => {
  it('shuffles A–D on the server: same seed, same order; the key and the distractor notes follow their text', async () => {
    const run = async (seed: string) => {
      const { store, saved } = memStore();
      ask.mockResolvedValueOnce(objReply(obj()));
      await generateQuestions(input({ questionType: 'objective', seed }), deps(store));
      return saved[0]!;
    };
    const a = await run('sessao-1');
    const b = await run('sessao-1');
    expect(b.alternatives).toEqual(a.alternatives);
    expect(b.correctKey).toBe(a.correctKey);
    const text = (q: QuestionBankServer, k: string) => q.alternatives!.find((x) => x.key === k)!.text;
    expect(text(a, a.correctKey!)).toBe('PAM ≥ 65 mmHg');
    expect(a.alternatives).toHaveLength(4);
    expect(a.distractorNotes?.[a.correctKey!]).toBeUndefined();
    for (const [k, note] of Object.entries(a.distractorNotes ?? {})) {
      expect({ 'PAM ≥ 50 mmHg': 'Baixo demais.', 'PAM ≥ 90 mmHg': 'Alto demais.', 'Sem alvo definido': 'Há alvo no card.' }[text(a, k)]).toBe(note);
    }
    const keys = new Set<string>();
    for (let i = 0; i < 12; i++) keys.add((await run(`s${i}`)).correctKey!);
    expect(keys.size).toBeGreaterThan(1); // the model's "B" does not reach the student
  });

  it('discards catch-all options and checks only the correct option for numbers', async () => {
    const { store, saved } = memStore();
    ask.mockResolvedValueOnce(objReply(obj({ alternativas: { A: 'PAM ≥ 50 mmHg', B: 'PAM ≥ 65 mmHg', C: 'PAM ≥ 90 mmHg', D: 'Todas as anteriores' } }), obj()));
    const r = await generateQuestions(input({ questionType: 'objective' }), deps(store));
    expect(r.ok && r.data.discarded.format).toBe(1);
    expect(saved).toHaveLength(1); // distractors with 50 and 90 mmHg are allowed: they are wrong on purpose
    expect(saved[0]).toMatchObject({ type: 'objective', expectedAnswer: 'PAM ≥ 65 mmHg', explanation: 'O alvo é PAM ≥ 65 mmHg.' });
  });
});

describe('map helpers', () => {
  it('scopes: card, module, branch (follows arrows) and board', () => {
    const cards = CARDS.map((c, i) => ({ ...c, didactics: { modulo: i === 2 ? 'M2' : 'M1', nivel: 1 } }));
    const edges = [{ fromCardId: C1, toCardId: C2, label: null }];
    const at = (scope: ChallengeScope) => scopeCardIds(scope, cards, edges);
    expect(at({ kind: 'card', cardId: C3 })).toEqual([C3]);
    expect(at({ kind: 'module', module: 'M1' })).toEqual([C1, C2]);
    expect(at({ kind: 'branch', rootCardId: C1 })).toEqual([C1, C2]);
    expect(at({ kind: 'branch', rootCardId: C2 })).toEqual([C2]);
    expect(at({ kind: 'board' })).toEqual([C1, C2, C3]);
  });

  it('serializes flow steps, case stages and mask labels so evidence can quote them', () => {
    const { text, refs } = serializeMap(ctx({
      cards: [
        { id: C1, type: 'flow', title: 'Fluxo sintético', front: null, back: null, payload: { steps: [{ id: 'a', text: 'Coletar culturas' }, { id: 'b', text: 'Iniciar antimicrobiano' }] }, didactics: null },
        { id: C2, type: 'case', title: 'Caso sintético', front: null, back: null, payload: { caseSteps: [{ stage: 'presentation', text: 'Febre e hipotensão' }] }, didactics: null },
        { id: C3, type: 'image', title: 'Imagem sintética', front: null, back: null, payload: { masks: [{ id: 'm', label: 'Ventrículo esquerdo' }] }, didactics: null },
      ],
      edges: [],
    }));
    expect(text).toContain('passos: 1) Coletar culturas 2) Iniciar antimicrobiano');
    expect(text).toContain('caso: apresentação: Febre e hipotensão');
    expect(text).toContain('imagem: rótulos: Ventrículo esquerdo');
    expect(refs.get('c3')?.id).toBe(C3);
  });
});
