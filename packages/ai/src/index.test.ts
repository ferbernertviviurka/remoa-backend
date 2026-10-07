import { describe, expect, it, vi } from 'vitest';
import { gradeOffline } from './offline';
import { runOfflineEval } from './eval';
import { graderCases } from './eval-cases';
import { chunkText, extractOffline, extractWithMeta, layout, mergeDrafts } from './extract';
import { cachedRubric, rubricFromCard } from './grade';
import { costCents, rememberPrice } from './client';
import { graderUser } from './openrouter';
import { pdfPageCount, pdfText } from './pdf';

describe('offline grader', () => {
  it('scores the eval set at or above 90% and catches every critical error', () => {
    const report = runOfflineEval();
    expect(report.n).toBe(50);
    expect(report.concordance).toBeGreaterThanOrEqual(0.9);
    expect(report.criticalExpected).toBe(10);
    expect(report.criticalHits).toBe(10);
    expect(report.p95Ms).toBeLessThan(50);
    expect(report.costCents).toBe(0);
  });

  it('treats "não sei" as incorrect', () => {
    const v = gradeOffline(graderCases.find((c) => c.id === 'blank')!.input);
    expect(v.verdict).toBe('incorrect');
    expect(v.criticalError).toBe(false);
  });

  it('marks a plausible answer outside the rubric as partial, with the missing points', () => {
    const v = gradeOffline(graderCases.find((c) => c.id === 'out')!.input);
    expect(v.verdict).toBe('partial');
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it('treats a route the rubric never states as a critical error', () => {
    const sample = graderCases.find((c) => c.id === 'c0')!.input;
    const wrongRoute = gradeOffline({
      ...sample,
      answer: 'Iniciar noradrenalina intramuscular para manter a pressão arterial média e reavaliar o lactato.',
    });
    expect(wrongRoute.criticalError).toBe(true);
    expect(wrongRoute.verdict).toBe('incorrect');
    const sameRoute = gradeOffline({
      ...sample,
      rubric: {
        ...sample.rubric,
        points: [...sample.rubric.points, { text: 'Preferir a via endovenosa', essential: false }],
      },
      answer: 'Iniciar noradrenalina intravenosa para manter a pressão arterial média e reavaliar o lactato.',
    });
    expect(sameRoute.criticalError).toBe(false);
  });

  it('does not count a shared verb as the drug the rubric asks for', () => {
    const sample = graderCases.find((c) => c.id === 'c0')!.input;
    const v = gradeOffline({ ...sample, answer: 'Iniciar antibiótico de amplo espectro na primeira hora.' });
    expect(v.matched).not.toContain('Iniciar noradrenalina');
    expect(v.verdict).not.toBe('correct');
  });
});

describe('rubric and extract', () => {
  it('caches a rubric for the same card text', () => {
    const a = rubricFromCard('Sepse', 'Iniciar noradrenalina. Manter a pressão arterial média.', 'SSC 2021');
    const b = rubricFromCard('Sepse', 'Iniciar noradrenalina. Manter a pressão arterial média.', 'SSC 2021');
    expect(b).toBe(a);
  });

  it('builds a draft rubric for six sepse cards', () => {
    const titles = ['Sepse', 'Choque séptico', 'Noradrenalina', 'Lactato', 'PAM', 'Pacote da primeira hora'];
    for (const title of titles) {
      const r = rubricFromCard(title, 'Iniciar noradrenalina. Manter a pressão arterial média. Reavaliar o lactato.', 'SSC 2021');
      expect(r.status).toBe('draft');
      expect(r.points.length).toBeGreaterThan(0);
      expect(r.reviewerId).toBeNull();
    }
  });

  it('reads a flowchart, a case and a labeled relation from an outline', () => {
    const text = [
      'Sepse.',
      'Disfunção orgânica causada por infecção.',
      '',
      'Fluxo: Conduta de sepse',
      '1. Reconhecer a disfunção',
      '2. Reavaliar depois do pacote inicial',
      '',
      'Caso: Caso de sepse',
      'Apresentação: febre e hipotensão',
      'Conduta: pacote inicial e reavaliação',
      '',
      'Relação: Sepse -> Conduta de sepse: conduta',
    ].join('\n');
    const map = extractOffline(text, 'ILAS');
    expect(map.cards.map((c) => c.type).sort()).toEqual(['case', 'concept', 'flow']);
    expect(map.edges).toEqual([{ fromRef: 'c1', toRef: 'c2', label: 'conduta' }]);
    const flow = map.cards.find((c) => c.type === 'flow');
    expect(flow?.payload).toMatchObject({ steps: [{ id: 's1' }, { id: 's2' }] });
  });

  it('merges duplicate titles across chunks', () => {
    const a = extractOffline('Sepse e choque.\n\nNoradrenalina é a droga.', 'fonte');
    const b = extractOffline('Sepse e choque.\n\nOutro parágrafo.', 'fonte');
    const merged = mergeDrafts([a, b]);
    const titles = merged.cards.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('keeps the fuller card and the labeled edge when the same title is merged', () => {
    const concept = (ref: string, title: string, back: string, front: string | null = null, source: string | null = null) => ({
      ref, type: 'concept' as const, title, front, back, source, payload: {},
    });
    const merged = mergeDrafts([
      {
        cards: [concept('a', 'Sepse', 'Curta.'), concept('c', 'Choque', 'Hipotensão.')],
        edges: [{ fromRef: 'a', toRef: 'c', label: null }],
      },
      {
        cards: [concept('b', 'sépse', 'Disfunção orgânica causada por infecção.', 'O que define?', 'ILAS')],
        edges: [{ fromRef: 'b', toRef: 'c', label: 'pode evoluir' }],
      },
    ]);
    expect(merged.cards).toHaveLength(2);
    expect(merged.cards[0]).toMatchObject({ ref: 'a', front: 'O que define?', source: 'ILAS', back: 'Disfunção orgânica causada por infecção.' });
    expect(merged.edges).toEqual([{ fromRef: 'a', toRef: 'c', label: 'pode evoluir' }]);
  });

  it('lays a target to the right of its source and keeps loose cards apart', () => {
    const concept = (ref: string) => ({ ref, type: 'concept' as const, title: ref, front: null, back: null, source: 's', payload: {} });
    const linked = layout([concept('a'), concept('b')], [{ fromRef: 'a', toRef: 'b', label: 'leva a' }]);
    const a = linked.find((p) => p.ref === 'a');
    const b = linked.find((p) => p.ref === 'b');
    expect(b!.x).toBeGreaterThan(a!.x);
    const loose = layout([concept('a'), concept('b'), concept('c')], []);
    expect(new Set(loose.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    expect(layout([concept('a'), concept('b')], [{ fromRef: 'a', toRef: 'b', label: null }, { fromRef: 'b', toRef: 'a', label: null }])).toHaveLength(2);
  });

  it('chunks long text', () => {
    expect(chunkText(`${'a'.repeat(20)}\n\n${'b'.repeat(20)}`, 25).length).toBe(2);
  });

  it('D-1568: a block with no blank line is split on its lines, so nothing past the first chunk is lost', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `linha ${i} do capitulo`);
    const chunks = chunkText(lines.join('\n'), 1000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.at(-1)).toContain('linha 299');
  });
});

describe('openrouter parse', () => {
  it('reads text stored inside a PDF literal string', () => {
    const bytes = new TextEncoder().encode('BT (Sepse e choque septico exige noradrenalina) Tj ET');
    expect(pdfText(bytes)).toContain('noradrenalina');
    expect(pdfPageCount(new TextEncoder().encode('/Type /Pages /Count 2 /Type /Page /Type /Page'))).toBe(2);
  });

  it('does not send the canonical answer to the model', () => {
    const secret = 'RESPOSTA-CANONICA-SECRETA';
    const body = graderUser({ ...graderCases[0]!.input, canonical: secret });
    expect(body).not.toContain(secret);
    expect(body).toContain(graderCases[0]!.input.answer);
  });

  it('prices from the catalog (USD per token) and is 0 for an unknown or free model', () => {
    rememberPrice('test/paid', 0.000003, 0.000015);
    rememberPrice('test/x:free', 0, 0);
    expect(costCents(1_000_000, 0, 'test/paid')).toBe(300);
    expect(costCents(0, 1_000_000, 'test/paid')).toBe(1500);
    expect(costCents(10, 10, 'test/paid')).toBe(1);
    expect(costCents(0, 0, 'test/paid')).toBe(0);
    expect(costCents(1_000_000, 1_000_000, 'test/x:free')).toBe(0);
    expect(costCents(1_000_000, 1_000_000, 'never/seen')).toBe(0);
  });

  it('extracts with OpenRouter when the key is set and falls back when the call fails', async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    const text = 'Sepse exige noradrenalina na primeira hora do choque.';
    const reply = JSON.stringify({
      cards: [{ ref: 'c1', type: 'concept', title: 'Noradrenalina', question: 'Qual droga?', answer: 'Noradrenalina', sourceExcerpt: 'Sepse exige noradrenalina na primeira hora', payload: {} }],
      edges: [],
    });
    const okFetch = (async () => Response.json({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 4 } })) as typeof fetch;
    const ok = await extractWithMeta(text, 'fonte', okFetch);
    expect(ok.extracted.cards.map((c) => c.title)).toEqual(['Noradrenalina']);
    expect(ok.meta.tokensIn).toBe(10);
    const badFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const bad = await extractWithMeta(text, 'fonte', badFetch);
    expect(bad.meta.model).toBe('offline-extract');
    expect(bad.extracted.cards.length).toBeGreaterThan(0);
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  });

  it('stops a generation that has already used the ten-minute budget', async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(extractWithMeta('Sepse exige noradrenalina na primeira hora.', 'fonte', fetchImpl, Date.now() - 1)).rejects.toThrow('generate_timeout');
    expect(fetchImpl).not.toHaveBeenCalled();
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  });
});

describe('rubric cache', () => {
  it('reuses the rubric for the same card text without calling the model again', () => {
    const first = rubricFromCard('Noradrenalina no choque', 'Iniciar na primeira hora.', 'Diretriz');
    expect(cachedRubric('Noradrenalina no choque', 'Iniciar na primeira hora.', 'Diretriz')).toEqual(first);
    expect(cachedRubric('Outro título', 'Iniciar na primeira hora.', 'Diretriz')).toBeNull();
  });
});
