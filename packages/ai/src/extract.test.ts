import { afterEach, describe, expect, it } from 'vitest';
import { extractOffline, extractWithMeta } from './extract';

afterEach(() => { delete process.env.OPENROUTER_API_KEY; });
const reply = (content: string) => (async () => Response.json({ model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })) as unknown as typeof fetch;
const run = (content: string) => { process.env.OPENROUTER_API_KEY = 'k'; return extractWithMeta('Texto longo o bastante.', 'fonte', reply(content)); };

describe('extractWithMeta model replies', () => {
  it('skips junk items, defaults the type and keeps valid cards and edges', async () => {
    const r = await run(JSON.stringify({
      cards: [null, 'x', { ref: 'c1', title: 'Sepse', front: null, back: 'Disfunção orgânica' }, { ref: 'c2', title: '' }],
      edges: [{ fromRef: 'c1', toRef: 'c1', label: 'x' }, 'lixo'],
    }));
    expect(r.extracted.cards.map((c) => c.title)).toEqual(['Sepse']);
    expect(r.meta.model).toBe('m');
  });
  it('tolerates a missing edges array', async () => {
    const r = await run(JSON.stringify({ cards: [{ ref: 'c1', title: 'Sepse', source: 'outra' }] }));
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
