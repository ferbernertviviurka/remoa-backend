import { describe, expect, it } from 'vitest';
import { gradeOffline } from './offline';
import { runOfflineEval } from './eval';
import { graderCases } from './eval-cases';
import { chunkText, extractOffline, extractWithMeta, mergeDrafts } from './extract';
import { cachedRubric, rubricFromCard } from './grade';
import { graderUser, parseVerdict } from './openrouter';
import { pdfText } from './pdf';

describe('offline grader', () => {
  it('scores the eval set at or above 90% and catches every critical error', () => {
    const report = runOfflineEval();
    expect(report.n).toBe(50);
    expect(report.concordance).toBeGreaterThanOrEqual(0.9);
    expect(report.criticalExpected).toBe(10);
    expect(report.criticalHits).toBe(10);
    expect(report.p95Ms).toBeLessThan(50);
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

  it('merges duplicate titles across chunks', () => {
    const a = extractOffline('Sepse e choque.\n\nNoradrenalina é a droga.', 'fonte');
    const b = extractOffline('Sepse e choque.\n\nOutro parágrafo.', 'fonte');
    const merged = mergeDrafts([a, b]);
    const titles = merged.cards.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('chunks long text', () => {
    expect(chunkText(`${'a'.repeat(20)}\n\n${'b'.repeat(20)}`, 25).length).toBe(2);
  });
});

describe('openrouter parse', () => {
  it('reads text stored inside a PDF literal string', () => {
    const bytes = new TextEncoder().encode('BT (Sepse e choque septico exige noradrenalina) Tj ET');
    expect(pdfText(bytes)).toContain('noradrenalina');
  });

  it('does not send the canonical answer to the model', () => {
    const secret = 'RESPOSTA-CANONICA-SECRETA';
    const body = graderUser({ ...graderCases[0]!.input, canonical: secret });
    expect(body).not.toContain(secret);
    expect(body).toContain(graderCases[0]!.input.answer);
  });

  it('accepts a model verdict', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'partial', matched: [], missing: ['x'], criticalError: false, feedback: 'faltou' }), 'anthropic/claude-3.5-haiku');
    expect(v.model).toBe('anthropic/claude-3.5-haiku');
  });

  it('extracts with OpenRouter when the key is set and falls back when the call fails', async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    const text = 'Sepse exige noradrenalina na primeira hora do choque.';
    const reply = JSON.stringify({
      cards: [{ ref: 'c1', type: 'concept', title: 'Noradrenalina', front: null, back: 'Droga do choque', source: null, payload: {} }],
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
});

describe('rubric cache', () => {
  it('reuses the rubric for the same card text without calling the model again', () => {
    const first = rubricFromCard('Noradrenalina no choque', 'Iniciar na primeira hora.', 'Diretriz');
    expect(cachedRubric('Noradrenalina no choque', 'Iniciar na primeira hora.', 'Diretriz')).toEqual(first);
    expect(cachedRubric('Outro título', 'Iniciar na primeira hora.', 'Diretriz')).toBeNull();
  });
});
