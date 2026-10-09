import { GenerationReceipts } from '../questions/generation/receipts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError, generateJson } from '@remoa/ai';
import { mapSummaryPublicSchema } from '@remoa/contracts';
import { reserveAi } from '../billing/quota';
import type { MapContext } from './generate';
import {
  SUMMARY_HISTORY, generateSummary, joinSections, latestSummary, listSummaries, planSummary,
  type GenerateSummaryInput, type SummaryDeps, type SummaryRow, type SummaryStore,
} from './summary';

vi.mock('@remoa/ai', async (orig) => ({ ...(await orig<typeof import('@remoa/ai')>()), generateJson: vi.fn() }));
vi.mock('../billing/quota', () => ({ reserveAi: vi.fn(), refundAt: vi.fn() }));

const ask = vi.mocked(generateJson);
const reserve = vi.mocked(reserveAi);

const USER = '44444444-4444-4444-8444-444444444444';
const BOARD = '55555555-5555-4555-8555-555555555555';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const PERIOD = '2026-10-01';
const NOW = new Date('2026-10-07T13:00:00Z');

// Synthetic text, not reference material.
const card = (id: string, title: string, front: string, back: string, modulo?: string) =>
  ({ id, type: 'concept', title, front, back, payload: {}, didactics: modulo ? { modulo } : null });
const CARDS = [
  card(C1, 'Definição sintética', 'O que define a síndrome sintética X?', 'Disfunção orgânica causada por resposta desregulada à infecção sintética.'),
  card(C2, 'Tempo do antimicrobiano', 'Quando iniciar o antimicrobiano na síndrome X?', 'Imediatamente, idealmente em até 1 hora do reconhecimento.'),
  card(C3, 'Alvo pressórico', 'Qual o alvo pressórico na síndrome X com vasopressor?', 'PAM ≥ 65 mmHg com o vasopressor alfa como primeira escolha.'),
];
const ctx = (over: Partial<MapContext> = {}): MapContext => ({
  boardId: BOARD, boardVersion: 3, title: 'Síndrome sintética X', area: 'CM', cards: CARDS, edges: [{ fromCardId: C1, toCardId: C2, label: 'leva a' }],
  tags: { areaId: null, domainId: null, competencyId: null, topicId: null }, topicName: null, ...over,
});

const item = (texto: string, cards: string[]) => ({ texto, cards });
const reply = (secoes: unknown[]) =>
  ({ data: { titulo: 'Síndrome X', secoes }, text: '', model: 'test/model', tokensIn: 10, tokensOut: 20, latencyMs: 5, attempts: 1, fallback: false, billable: true as const, repaired: false });
const overview = (...itens: ReturnType<typeof item>[]) => ({ tipo: 'visao_geral', itens });

function memStore(over: { context?: MapContext | null; rows?: SummaryRow[]; version?: number | null } = {}) {
  const rows: SummaryRow[] = [...(over.rows ?? [])];
  const store: SummaryStore = {
    context: vi.fn(async () => (over.context === undefined ? ctx() : over.context)),
    version: vi.fn(async () => (over.version === undefined ? 3 : over.version)),
    list: vi.fn(async (_u, _b, limit) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit)),
    insert: vi.fn(async (_u, row) => void rows.push(row)),
    remove: vi.fn(async (_u, _b, ids) => void rows.splice(0, rows.length, ...rows.filter((r) => !ids.includes(r.id)))),
  };
  return { store, rows };
}
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const deps = (store: SummaryStore): SummaryDeps => ({ store, now: () => NOW, newId });
const input = (over: Partial<GenerateSummaryInput> = {}): GenerateSummaryInput => ({ userId: USER, boardId: BOARD, size: 'standard', focus: 'overview', ...over });
const savedRow = (n: number, over: Partial<SummaryRow> = {}): SummaryRow => ({
  id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, userId: USER, boardId: BOARD, boardVersion: 3, size: 'standard', focus: 'overview',
  content: [{ kind: 'overview', title: 'Visão geral', items: [{ text: 'Resumo antigo.', cardIds: [C1] }] }], cardsCited: [C1], model: 'test/model',
  promptVersion: 'desafios/resumir-mapa@v1', stale: false, createdAt: new Date(NOW.getTime() - (10 - n) * 3600_000), ...over,
});
const refundFn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  reserve.mockResolvedValue({ ok: true, quota: { key: 'ai_summaries', used: 1, limit: 5, period: PERIOD, remaining: 4, nearLimit: false }, refund: refundFn });
});

describe('generateSummary: one call for a normal map', () => {
  it('summarizes with one generateJson call and saves the row with the prompt and board version', async () => {
    const { store, rows } = memStore();
    ask.mockResolvedValueOnce(reply([
      overview(item('A síndrome X é uma disfunção orgânica causada por resposta desregulada à infecção.', ['c1'])),
      { tipo: 'pontos_chave', modulo: 'Tratamento', itens: [item('Iniciar o antimicrobiano imediatamente, em até 1 hora.', ['c2']), item('Alvo de PAM ≥ 65 mmHg.', ['c3'])] },
    ]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[1]).toMatchObject({ fn: 'summary' });
    expect(reserve).toHaveBeenCalledWith(USER, 'ai_summaries', NOW);
    expect(refundFn).not.toHaveBeenCalled();
    expect(mapSummaryPublicSchema.safeParse(r.data).success).toBe(true);
    expect(r.data).toMatchObject({ boardId: BOARD, boardVersion: 3, size: 'standard', focus: 'overview', stale: false });
    expect(r.data.sections.map((s) => s.kind)).toEqual(['overview', 'module_points']);
    expect(r.data.sections[0]?.items[0]?.cardIds).toEqual([C1]); // short ids come back as card ids
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boardVersion: 3, promptVersion: 'desafios/resumir-mapa@v1', model: 'test/model', stale: false });
    expect(rows[0]?.cardsCited.sort()).toEqual([C1, C2, C3]);
  });

  it('sends the map as data with short ids and no card uuid, and does not leak anything the model added besides the schema', async () => {
    const { store } = memStore();
    const r0 = reply([overview(item('Texto fiel ao card.', ['c1']))]);
    ask.mockResolvedValueOnce({ ...r0, data: { ...r0.data, raciocinio: 'passo a passo secreto' } as typeof r0.data, text: 'passo a passo secreto' });
    const r = await generateSummary(input({ size: 'quick', focus: 'exam_eve' }), deps(store));
    const system = (ask.mock.calls[0]?.[1] as { system: string }).system;
    expect(system).toContain('[c1]');
    expect(system).toContain('véspera de prova');
    expect(system).not.toContain(C1);
    expect(JSON.stringify(r)).not.toContain('passo a passo');
  });
});

describe('generateSummary: guards', () => {
  it('drops items with no valid card (unknown id, a card of another board, none) and keeps the rest; a partly valid citation keeps the valid ids', async () => {
    const { store, rows } = memStore();
    ask.mockResolvedValueOnce(reply([overview(
      item('Sem nenhum card citado.', []),
      item('Cita um card que não existe no mapa.', ['c9']),
      item('Cita um card de outro mapa pelo id.', [FOREIGN]),
      item('Disfunção orgânica por resposta desregulada à infecção.', ['c1', 'c9']),
      item('Cita pelo id real do card do mapa.', [C2]),
    )]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok && r.data.sections[0]?.items).toEqual([
      { text: 'Disfunção orgânica por resposta desregulada à infecção.', cardIds: [C1] },
      { text: 'Cita pelo id real do card do mapa.', cardIds: [C2] },
    ]);
    expect(rows).toHaveLength(1);
  });

  it('drops an item whose number or dose is not written in the cited cards, and checks against the cited cards only', async () => {
    const { store } = memStore();
    ask.mockResolvedValueOnce(reply([overview(
      item('Iniciar o antimicrobiano em até 3 horas.', ['c2']),
      item('Alvo de PAM ≥ 70 mmHg.', ['c3']),
      item('O alvo de PAM é ≥ 65 mmHg.', ['c2']), // 65 exists, but on c3, which is not cited here
      item('Iniciar o antimicrobiano em até 1 hora.', ['c2']),
      item('Alvo de PAM ≥ 65 mmHg.', ['c3']),
    )]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok && r.data.sections[0]?.items.map((i) => i.text)).toEqual(['Iniciar o antimicrobiano em até 1 hora.', 'Alvo de PAM ≥ 65 mmHg.']);
  });

  it('applies both guards to comparison rows, and a section left with nothing is omitted', async () => {
    const { store } = memStore();
    ask.mockResolvedValueOnce(reply([
      { tipo: 'comparacao', colunas: ['Aspecto', 'Conduta'], linhas: [['Antimicrobiano', 'em até 1 hora'], ['Antimicrobiano', 'em até 6 horas'], ['Vasopressor']], cards: ['c2', 'c3'] },
      { tipo: 'macetes', itens: [item('Macete inventado sem card.', [])] },
    ]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok && r.data.sections).toHaveLength(1);
    expect(r.ok && r.data.sections[0]).toMatchObject({ kind: 'comparisons', items: [], table: { header: ['Aspecto', 'Conduta'], rows: [{ cells: ['Antimicrobiano', 'em até 1 hora'], cardIds: [C2, C3] }] } });
  });

  it('refunds and saves nothing when every item is dropped', async () => {
    const { store, rows } = memStore();
    ask.mockResolvedValueOnce(reply([overview(item('Sem card.', []), item('Dose de 500 mg.', ['c1']))]));
    const r = await generateSummary(input(), deps(store));
    expect(r).toMatchObject({ ok: false, error: { code: 'ai_unavailable' } });
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });
});

describe('generateSummary: large map', () => {
  const moduleCards = (module: string, n: number, from: number) =>
    Array.from({ length: n }, (_, i) => card(`00000000-0000-4000-8000-${String(from + i).padStart(12, '1')}`, `Card ${module} ${i + 1}`, `Frente ${module} ${i + 1}?`, `Verso ${module} ${i + 1}.`, module));

  it('plans one call per module above 4 modules, and above 40 cards', () => {
    expect(planSummary(CARDS)).toMatchObject({ large: false, groups: [{ module: null }] });
    const five = ['A', 'B', 'C', 'D', 'E'].flatMap((m, i) => moduleCards(m, 2, i * 10));
    const p5 = planSummary(five);
    expect(p5.large).toBe(true);
    expect(p5.groups.map((g) => [g.module, g.cards.length])).toEqual([['A', 2], ['B', 2], ['C', 2], ['D', 2], ['E', 2]]);
    const p41 = planSummary([...moduleCards('A', 21, 0), ...moduleCards('B', 20, 100)]);
    expect(p41).toMatchObject({ large: true, groups: [{ module: 'A' }, { module: 'B' }] });
    expect(planSummary([...moduleCards('A', 40, 0), ...moduleCards('B', 4, 100)]).large).toBe(true);
    expect(planSummary(moduleCards('A', 40, 0)).large).toBe(false);
  });

  it('calls once per module and joins in code without another call', async () => {
    const cards = ['A', 'B', 'C', 'D', 'E'].flatMap((m, i) => moduleCards(m, 2, i * 10));
    const { store, rows } = memStore({ context: ctx({ cards, edges: [] }) });
    ask.mockImplementation(async (_schema, opts) => {
      const system = (opts as { system: string }).system;
      const m = /módulo (\w)\)/.exec(system)?.[1] ?? '?';
      return reply([
        overview(item(`Visão do módulo ${m}.`, ['c1'])),
        { tipo: 'pontos_chave', itens: [item(`Ponto do módulo ${m}.`, ['c2'])] },
        { tipo: 'checklist', itens: [item(`Pergunta ${m}1?`, ['c1']), item(`Pergunta ${m}2?`, ['c2']), item(`Pergunta ${m}3?`, ['c1'])] },
      ]);
    });
    const r = await generateSummary(input(), deps(store));
    expect(ask).toHaveBeenCalledTimes(5); // five modules, no join call
    expect(refundFn).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kinds = r.data.sections.map((s) => s.kind);
    expect(kinds).toEqual(['overview', 'module_points', 'module_points', 'module_points', 'module_points', 'module_points', 'checklist']);
    expect(r.data.sections.filter((s) => s.kind === 'module_points').map((s) => s.module)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(r.data.sections[0]?.items).toHaveLength(5);
    expect(r.data.sections.at(-1)?.items).toHaveLength(10); // checklist cap
    expect(rows).toHaveLength(1);
    // each call carries only its module's cards
    const systemB = (ask.mock.calls[1]?.[1] as { system: string }).system;
    expect(systemB).toContain('Card B 1');
    expect(systemB).not.toContain('Card A 1');
  });

  it('fails the whole summary and refunds when one module call fails', async () => {
    const cards = ['A', 'B', 'C', 'D', 'E'].flatMap((m, i) => moduleCards(m, 2, i * 10));
    const { store, rows } = memStore({ context: ctx({ cards, edges: [] }) });
    ask.mockResolvedValueOnce(reply([overview(item('Visão.', ['c1']))])).mockRejectedValue(new AiError('timeout'));
    const r = await generateSummary(input(), deps(store));
    expect(r).toMatchObject({ ok: false, error: { code: 'ai_unavailable' } });
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });
});

describe('joinSections', () => {
  const sec = (kind: 'overview' | 'checklist' | 'flows', n: number, tag = '') =>
    ({ kind, title: kind, items: Array.from({ length: n }, (_, i) => ({ text: `${tag}${i}`, cardIds: [C1] })) });
  it('merges by kind in FR-48 order, caps the checklist at 10 and never goes past 12 sections', () => {
    const out = joinSections([[sec('checklist', 6), sec('overview', 1, 'a')], [sec('overview', 1, 'b'), sec('checklist', 6), sec('flows', 1)]]);
    expect(out.map((s) => s.kind)).toEqual(['overview', 'flows', 'checklist']);
    expect(out[0]?.items.map((i) => i.text)).toEqual(['a0', 'b0']);
    expect(out[2]?.items).toHaveLength(10);
    const modules = Array.from({ length: 14 }, (_, i) => [{ kind: 'module_points' as const, title: `M${i}`, module: `M${i}`, items: [{ text: 'x', cardIds: [C1] }] }]);
    const many = joinSections([[sec('overview', 1)], ...modules, [sec('checklist', 5)]]);
    expect(many).toHaveLength(12);
    expect(many[0]?.kind).toBe('overview');
    expect(many.at(-1)?.kind).toBe('checklist');
  });
});

describe('generateSummary: quota and failures', () => {
  it('reserves before the call and returns the quota error without calling the model', async () => {
    const { store } = memStore();
    reserve.mockResolvedValueOnce({ ok: false, error: { code: 'quota_exceeded', message: 'ai_summaries' } });
    const r = await generateSummary(input(), deps(store));
    expect(r).toMatchObject({ ok: false, error: { code: 'quota_exceeded', message: 'ai_summaries' } });
    expect(ask).not.toHaveBeenCalled();
  });

  it('refunds the unit and saves nothing when the model call throws (rate limit maps to rate_limited)', async () => {
    const { store, rows } = memStore();
    ask.mockRejectedValueOnce(new AiError('rate_limited'));
    const r = await generateSummary(input(), deps(store));
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(refundFn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });

  it('refunds and rethrows an unexpected error, and refunds when the save fails', async () => {
    const { store } = memStore();
    ask.mockRejectedValueOnce(new Error('boom'));
    await expect(generateSummary(input(), deps(store))).rejects.toThrow('boom');
    expect(refundFn).toHaveBeenCalledTimes(1);

    ask.mockResolvedValueOnce(reply([overview(item('Texto fiel ao card.', ['c1']))]));
    vi.mocked(store.insert).mockRejectedValueOnce(new Error('db down'));
    await expect(generateSummary(input(), deps(store))).rejects.toThrow('db down');
    expect(refundFn).toHaveBeenCalledTimes(2);
  });

  it('answers not_found for a board that is not the user\'s, and validation for an empty map, without reserving', async () => {
    expect(await generateSummary(input(), deps(memStore({ context: null }).store))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await generateSummary(input(), deps(memStore({ context: ctx({ cards: [] }) }).store))).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('calls the model again on every request: the answer is not cached', async () => {
    const { store, rows } = memStore();
    ask.mockResolvedValue(reply([overview(item('Texto fiel ao card.', ['c1']))]));
    await generateSummary(input(), deps(store));
    await generateSummary(input(), deps(store));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });
});

describe('history and stale', () => {
  it('regenerating inserts a new row and keeps only the last 5, dropping the oldest', async () => {
    const old = [1, 2, 3, 4, 5].map((n) => savedRow(n));
    const { store, rows } = memStore({ rows: old });
    ask.mockResolvedValueOnce(reply([overview(item('Texto fiel ao card.', ['c1']))]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok).toBe(true);
    expect(store.insert).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(SUMMARY_HISTORY);
    expect(rows.map((x) => x.id)).not.toContain(old[0]!.id);
    expect(rows.map((x) => x.id)).toContain(old[4]!.id);
    expect(rows.find((x) => x.id === (r.ok ? r.data.id : ''))).toBeDefined();
    expect(old.every((o) => o.content[0]?.items[0]?.text === 'Resumo antigo.')).toBe(true); // old rows untouched
  });

  it('keeps everything while there are fewer than 5, and a failed prune does not fail the summary', async () => {
    const { store, rows } = memStore({ rows: [savedRow(1), savedRow(2)] });
    ask.mockResolvedValue(reply([overview(item('Texto fiel ao card.', ['c1']))]));
    await generateSummary(input(), deps(store));
    expect(rows).toHaveLength(3);
    expect(store.remove).toHaveBeenCalledWith(USER, BOARD, []);

    vi.mocked(store.remove).mockRejectedValueOnce(new Error('prune failed'));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok).toBe(true);
    expect(refundFn).not.toHaveBeenCalled();
  });

  it('says stale: true when the board version differs from the saved row, false when it matches', async () => {
    const { store } = memStore({ rows: [savedRow(1, { boardVersion: 3 })], version: 4 });
    const stale = await latestSummary(USER, BOARD, deps(store));
    expect(stale.ok && stale.data?.stale).toBe(true);
    expect(stale.ok && mapSummaryPublicSchema.safeParse(stale.data).success).toBe(true);

    const fresh = await latestSummary(USER, BOARD, deps(memStore({ rows: [savedRow(1, { boardVersion: 3 })], version: 3 }).store));
    expect(fresh.ok && fresh.data?.stale).toBe(false);
  });

  it('lists history newest first with stale per row, and null when there is no summary', async () => {
    const { store } = memStore({ rows: [savedRow(1, { boardVersion: 2 }), savedRow(2, { boardVersion: 3 })], version: 3 });
    const list = await listSummaries(USER, BOARD, deps(store));
    expect(list.ok && list.data.map((s) => [s.boardVersion, s.stale])).toEqual([[3, false], [2, true]]);
    const none = await latestSummary(USER, BOARD, deps(memStore().store));
    expect(none).toEqual({ ok: true, data: null });
    expect(await listSummaries(USER, BOARD, deps(memStore({ version: null }).store))).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('a summary generated now is not stale, and the public shape never carries user_id or the prompt', async () => {
    const { store } = memStore();
    ask.mockResolvedValueOnce(reply([overview(item('Texto fiel ao card.', ['c1']))]));
    const r = await generateSummary(input(), deps(store));
    expect(r.ok && r.data.stale).toBe(false);
    expect(r.ok && Object.keys(r.data).sort()).toEqual(['boardId', 'boardVersion', 'createdAt', 'focus', 'id', 'sections', 'size', 'stale']);
  });
});

it('F33 summary injects receipt hooks before checklist screening and refunds persistence failure',async()=>{
  const {store}=memStore();let ledger:GenerationReceipts|undefined;const receipts:NonNullable<SummaryDeps['receipts']>=meta=>{ledger=new GenerationReceipts(meta);vi.spyOn(ledger,'wrap').mockRejectedValue(Error('synthetic receipt outage'));return ledger;};
  await expect(generateSummary(input(),{...deps(store),receipts})).rejects.toThrow();expect(ledger!.meta.producer).toBe('summary_checklist');expect(ledger!.wrap).toHaveBeenCalledTimes(1);expect(refundFn).toHaveBeenCalledTimes(1);expect(store.insert).not.toHaveBeenCalled();
});
