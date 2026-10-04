import { afterEach, describe, expect, it } from 'vitest';
import type { GraderInput } from '@remoa/contracts';
import { gradeWithMeta, rubricFromCard, rubricWithMeta, streamGrade, cachedRubric } from './grade';

const input: GraderInput = {
  prompt: 'Qual a droga do choque?',
  canonical: 'noradrenalina',
  rubric: { points: [{ text: 'noradrenalina', essential: true }], source: 'ILAS', version: 1, status: 'draft', reviewerId: null },
  neighbors: [],
  answer: 'não sei',
};
const withKey = () => { process.env.OPENROUTER_API_KEY = 'test-key'; };
afterEach(() => { delete process.env.OPENROUTER_API_KEY; });
const sse = (...chunks: string[]) => chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
const completion = (content: string) => (async () => Response.json({ model: 'm', choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 7 } })) as unknown as typeof fetch;
const failing = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;

describe('gradeWithMeta', () => {
  it('works offline without a key', async () => {
    const r = await gradeWithMeta(input);
    expect(r.verdict.model).toBe('offline-grader');
  });
  it('falls back offline when the request fails', async () => {
    withKey();
    expect((await gradeWithMeta(input, failing)).verdict.model).toBe('offline-grader');
  });
  it('falls back offline when the reply is not a verdict', async () => {
    withKey();
    expect((await gradeWithMeta(input, completion('nope'))).meta.tokensIn).toBe(0);
  });
});

describe('streamGrade fallbacks', () => {
  it('chunks the offline grader when the stream fails before any feedback', async () => {
    withKey();
    const events = [];
    for await (const e of streamGrade(input, failing)) events.push(e);
    expect(events.at(-1)?.verdict?.model).toBe('offline-grader');
    expect(events.length).toBeGreaterThan(1);
  });
  it('keeps shown feedback and ends with the offline verdict when the stream breaks late', async () => {
    withKey();
    const body = sse('{"verdict":"incorrect","feedback":"Faltou algo');
    const events = [];
    for await (const e of streamGrade(input, (async () => new Response(body)) as unknown as typeof fetch)) events.push(e);
    expect(events[0]?.feedback).toBe('Faltou algo');
    expect(events.at(-1)?.verdict?.model).toBe('offline-grader');
  });
});

describe('rubrics', () => {
  it('builds and caches the offline rubric', () => {
    const r = rubricFromCard('Choque séptico', 'Noradrenalina é a primeira escolha. Reposição volêmica precoce', 'src-a');
    expect(r.points[0]?.essential).toBe(true);
    expect(rubricFromCard('Choque séptico', 'Noradrenalina é a primeira escolha. Reposição volêmica precoce', 'src-a')).toBe(r);
    expect(cachedRubric('Choque séptico', 'Noradrenalina é a primeira escolha. Reposição volêmica precoce', 'src-a')).toBe(r);
    expect(cachedRubric('x', null, 'nope')).toBeNull();
  });
  it('falls back to the title when the back has no usable sentence', () => {
    expect(rubricFromCard('Titulo', null, 'src-b').points[0]?.text).toBe('Titulo');
  });
  it('is offline without a key', async () => {
    expect((await rubricWithMeta('T1', 'curto', 's')).meta.model).toBe('offline-rubric');
  });
  it('parses a model rubric and caches it as draft', async () => {
    withKey();
    const reply = JSON.stringify({ points: [{ text: 'Noradrenalina', essential: true }] });
    const r = await rubricWithMeta('T2', 'back', 's2', completion(reply));
    expect(r.rubric.status).toBe('draft');
    expect(r.meta).toMatchObject({ tokensIn: 5, tokensOut: 7 });
    expect(cachedRubric('T2', 'back', 's2')).toEqual(r.rubric);
  });
  it('uses the offline rubric (with real meta) when the reply fails the schema', async () => {
    withKey();
    const r = await rubricWithMeta('T3', 'back', 's3', completion(JSON.stringify({ points: [] })));
    expect(r.meta.tokensIn).toBe(5);
    expect(r.rubric.points.length).toBeGreaterThan(0);
  });
  it('uses the offline rubric on failure', async () => {
    withKey();
    expect((await rubricWithMeta('T4', 'back', 's4', failing)).meta.model).toBe('offline-rubric');
  });
});
