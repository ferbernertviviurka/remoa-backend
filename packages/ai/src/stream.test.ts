import { describe, expect, it } from 'vitest';
import type { GraderInput } from '@remoa/contracts';
import { feedbackSoFar, gradeWithMeta, streamGrade } from './index';

const input: GraderInput = {
  prompt: 'Qual a droga do choque?',
  canonical: 'noradrenalina',
  rubric: { points: [{ text: 'noradrenalina', essential: true }], source: 'ILAS', version: 1, status: 'draft', reviewerId: null },
  neighbors: [],
  answer: 'não sei',
};

describe('feedback stream', () => {
  it('reads a feedback value that is still open', () => {
    expect(feedbackSoFar('{"verdict":"incorrect","feedback":"Sem resp')).toBe('Sem resp');
    expect(feedbackSoFar('{"feedback":"linha\\nseguinte"}')).toBe('linha\nseguinte');
  });

  it('chunks the local grader when OpenRouter has no key', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const events = [];
    for await (const event of streamGrade(input)) events.push(event);
    const text = events.filter((e) => e.feedback).map((e) => e.feedback).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-1)?.verdict?.verdict).toBe('incorrect');
    expect(events.at(-1)?.verdict?.model).toBe('offline-grader');
  });

  it('emits feedback as the model stream grows', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const payload = '{"verdict":"incorrect","matched":[],"missing":["noradrenalina"],"criticalError":false,"feedback":"Faltou noradrenalina."}';
    const sse = [`data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(0, 80) } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(80) } }], model: 'anthropic/claude-3.5-haiku' })}\n\n`, 'data: [DONE]\n\n'].join('');
    const fetchImpl = async () => new Response(sse);
    try {
      const events = [];
      for await (const event of streamGrade(input, fetchImpl)) events.push(event);
      expect(events.filter((e) => e.feedback).map((e) => e.feedback).join('')).toBe('Faltou noradrenalina.');
      expect(events.at(-1)?.verdict?.verdict).toBe('incorrect');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('asks the model to call the grade tool and reads that payload', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    let sent: { messages?: { role: string; content: string }[]; tools?: { function: { name: string } }[]; tool_choice?: { function: { name: string } } } | undefined;
    const argumentsJson = JSON.stringify({ verdict: 'partial', matched: ['cultura'], missing: ['reavaliar'], criticalError: false, feedback: 'Faltou reavaliar.' });
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        model: 'anthropic/claude-3.5-haiku',
        choices: [{ message: { tool_calls: [{ function: { name: 'grade', arguments: argumentsJson } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 12 },
      });
    }) as typeof fetch;
    try {
      const graded = await gradeWithMeta(input, fetchImpl);
      expect(sent?.tools?.[0]?.function.name).toBe('grade');
      expect(sent?.tool_choice?.function.name).toBe('grade');
      expect(sent?.messages?.find((m) => m.role === 'system')?.content).toContain('Chame a ferramenta grade');
      expect(graded.verdict.verdict).toBe('partial');
      expect(graded.verdict.missing).toEqual(['reavaliar']);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
