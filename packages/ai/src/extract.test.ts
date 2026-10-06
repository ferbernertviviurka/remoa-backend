import { afterEach, describe, expect, it } from 'vitest';
import { extractOffline, extractWithMeta } from './extract';

afterEach(() => { delete process.env.OPENROUTER_API_KEY; });
const reply = (content: string) => (async () => Response.json({ model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })) as unknown as typeof fetch;
const TEXT = 'Sepse é disfunção orgânica por resposta desregulada à infecção.';
const run = (content: string, maxCards?: number) => { process.env.OPENROUTER_API_KEY = 'k'; return extractWithMeta(TEXT, 'fonte', reply(content), undefined, maxCards); };
const card = (ref: string, title: string, sourceExcerpt = 'disfunção orgânica por resposta desregulada') => ({ ref, type: 'concept', title, question: `O que é ${title}?`, answer: 'Disfunção orgânica', sourceExcerpt, payload: {} });

describe('extractWithMeta model replies', () => {
  it('skips junk items, defaults the type and keeps valid cards and edges', async () => {
    const r = await run(JSON.stringify({
      cards: [null, 'x', { ...card('c1', 'Sepse'), type: 'weird' }, { ref: 'c2', title: '' }],
      edges: [{ fromRef: 'c1', toRef: 'c1', label: 'x' }, 'lixo'],
    }));
    expect(r.extracted.cards.map((c) => c.title)).toEqual(['Sepse']);
    expect(r.extracted.cards[0]).toMatchObject({ type: 'concept', front: 'O que é Sepse?', back: 'Disfunção orgânica', source: 'fonte', sourceExcerpt: 'disfunção orgânica por resposta desregulada' });
    expect(r.meta.model).toBe('m');
  });
  it('drops cards whose excerpt is not in the text, and goes offline when none is grounded', async () => {
    const r = await run(JSON.stringify({ cards: [card('c1', 'Sepse'), card('c2', 'Dengue', 'A dengue é transmitida pelo mosquito')], edges: [] }));
    expect(r.extracted.cards.map((c) => c.title)).toEqual(['Sepse']);
    expect(r.meta.dropped).toBe(1);
    const none = await run(JSON.stringify({ cards: [card('c2', 'Dengue', 'A dengue é transmitida pelo mosquito')] }));
    expect(none.meta.model).toBe('offline-extract');
  });
  it('keeps only named edges between kept cards and caps at maxCards', async () => {
    const r = await run(JSON.stringify({
      cards: [card('c1', 'Sepse'), card('c2', 'Disfunção'), card('c3', 'Infecção')],
      edges: [{ fromRef: 'c1', toRef: 'c2', label: 'causa' }, { fromRef: 'c1', toRef: 'c3', label: '' }, { fromRef: 'c2', toRef: 'c3', label: 'vem de' }],
    }), 2);
    expect(r.extracted.cards.map((c) => c.ref)).toEqual(['c1', 'c2']);
    expect(r.extracted.edges).toEqual([{ fromRef: 'c1', toRef: 'c2', label: 'causa' }]);
  });
  it('throws no_content when the model validly finds nothing to study', async () => {
    await expect(run(JSON.stringify({ cards: [], edges: [] }))).rejects.toThrow('no_content');
  });
  it('tolerates a missing edges array', async () => {
    const r = await run(JSON.stringify({ cards: [card('c1', 'Sepse')] }));
    expect(r.extracted.edges).toEqual([]);
  });
  it('goes offline when cards is not an array or none are valid', async () => {
    expect((await run(JSON.stringify({ cards: 1 }))).meta.model).toBe('offline-extract');
    expect((await run(JSON.stringify({ cards: [{ title: '' }] }))).meta.model).toBe('offline-extract');
  });
  it('rethrows the generate timeout', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    await expect(extractWithMeta('t', 'f', reply('{}'), Date.now() - 1)).rejects.toThrow('generate_timeout');
  });
});

describe('extractOffline blocks', () => {
  it('reads relation, flow and case blocks', () => {
    const text = [
      'Sepse',
      'Choque',
      'Relação: Sepse -> Choque: evolui para',
      'Fluxo: Conduta',
      '1. Cultura\n2. Antibiótico',
      'Caso: Paciente',
      'Queixa: febre\nConduta: antibiótico\nQueixa: repetida',
    ].join('\n\n');
    const m = extractOffline(text, 'fonte');
    expect(m.cards.length).toBeGreaterThan(0);
    expect(extractOffline('Fluxo: Vazio\n1. \n', 'f').cards.length).toBeDefined();
    expect(extractOffline('Caso: Sem etapas\nlixo', 'f').cards.length).toBeDefined();
  });
});

describe('extractWithMeta over several chunks', () => {
  it('keeps refs unique when every chunk numbers its cards from c1', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    const a = 'Sepse é disfunção orgânica por resposta desregulada à infecção. '.repeat(60);
    const b = 'Choque séptico exige vasopressor para manter a pressão arterial média. '.repeat(60);
    const replies = [
      { cards: [{ ref: 'c1', type: 'concept', title: 'Sepse', question: 'O que é?', answer: 'Disfunção', sourceExcerpt: 'Sepse é disfunção orgânica', payload: {} }], edges: [] },
      { cards: [{ ref: 'c1', type: 'concept', title: 'Choque', question: 'O que exige?', answer: 'Vasopressor', sourceExcerpt: 'Choque séptico exige vasopressor', payload: {} }], edges: [] },
    ];
    const fetchImpl = (async () => Response.json({ model: 'm', choices: [{ message: { content: JSON.stringify(replies.shift()) } }] })) as unknown as typeof fetch;
    const r = await extractWithMeta(`${a}\n\n${b}`, 'fonte', fetchImpl);
    expect(r.extracted.cards.map((c) => c.ref)).toEqual(['c1', 'k1-c1']);
  });
});
