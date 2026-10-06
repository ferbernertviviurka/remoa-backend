import { describe, expect, it } from 'vitest';
describe('G22 CCR-072', () => {
  it('verdict carries optional source/sourceQuote; events carry no content', async () => {
    const { graderVerdictSchema } = await import('./ai');
    const { eventSchemas } = await import('./events');
    const base = { verdict: 'correct', matched: [], missing: [], criticalError: false, feedback: 'ok', model: 'm' };
    expect(graderVerdictSchema.safeParse(base).success).toBe(true);
    expect(graderVerdictSchema.parse({ ...base, source: 'SSC 2021', sourceQuote: null }).source).toBe('SSC 2021');
    expect(eventSchemas.ai_error_shown.safeParse({ code: 'rate_limited' }).success).toBe(true);
    expect(eventSchemas.ai_error_shown.safeParse({ code: 'x', text: 'resposta' }).success).toBe(false);
    expect(eventSchemas.ai_grade_flagged.safeParse({}).success).toBe(true);
    expect(eventSchemas.ai_grade_flagged.safeParse({ answer: 'x' }).success).toBe(false);
  });
});
