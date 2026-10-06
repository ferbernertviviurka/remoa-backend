import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowGrade, jobErrorCode, sourcedCards, startGeneration, startPdfGeneration } from './service';

const env = { ...process.env };
beforeEach(() => {
  process.env.AI = 'mock'; // D-580: offline drafts are an explicit dev/test mode
});
afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

const pdfBoard = { title: 'Sepse', area: 'CM' as const, access: 'owner' as const, matrixItemIds: [] };

describe('grade rate limit', () => {
  it('allows 30 corrections per minute and blocks the 31st', () => {
    const user = 'rate-limit-user';
    const start = 1_700_000_000_000;
    for (let i = 0; i < 30; i++) expect(allowGrade(user, start)).toBe(true);
    expect(allowGrade(user, start + 1_000)).toBe(false);
    expect(allowGrade(user, start + 61_000)).toBe(true);
  });
});

describe('AI not configured (D-580)', () => {
  it('no OPENROUTER_API_KEY and no AI=mock: 503 ai_unavailable before any job starts', async () => {
    delete process.env.AI;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DATABASE_URL;
    const pdf = await startPdfGeneration('ai-off-user', pdfBoard, new TextEncoder().encode('%PDF-1.4 (Sepse grave com hipotensao refrataria) Tj'));
    expect(pdf).toEqual({ ok: false, error: { code: 'ai_unavailable', message: 'ai_not_configured' } });
    const text = await startGeneration('ai-off-user', { kind: 'text', title: 'Sepse', area: 'CM', text: 'Sepse. '.repeat(20) } as Parameters<typeof startGeneration>[1]);
    expect(text).toMatchObject({ ok: false, error: { code: 'ai_unavailable' } });
  });
});

// G22: the job tests (mock map, PDF, cancel, retry) need the ai_jobs table: g22.test.ts (integration).

describe('sourcedCards (D-1414)', () => {
  const text = 'A sepse é uma disfunção orgânica ameaçadora à vida, causada por resposta desregulada à infecção.';
  it('keeps a card whose excerpt is literally in the text (accents, case, punctuation ignored) and drops the rest', () => {
    const cards = [
      { ref: 'a', sourceExcerpt: 'DISFUNCAO organica ameacadora a vida' },
      { ref: 'b', sourceExcerpt: 'Choque séptico exige vasopressor' },
      { ref: 'c', sourceExcerpt: '' },
      { ref: 'd' },
      { ref: 'e', sourceExcerpt: 'sepse' }, // too short to prove anything
    ];
    expect(sourcedCards(cards, text).map((c) => c.ref)).toEqual(['a']);
  });
});

describe('jobErrorCode (G22 qa, P-614)', () => {
  it('stores a known job code, never a raw exception text', () => {
    expect(jobErrorCode(new Error('no_content'))).toBe('no_content');
    expect(jobErrorCode(new Error('generate_timeout'))).toBe('generate_timeout');
    expect(jobErrorCode(new Error('duplicate key value violates unique constraint "cards_pkey"'))).toBe('failed');
    expect(jobErrorCode('boom')).toBe('failed');
    // D-1446: text Postgres cannot store (NUL, bad encoding), also wrapped by drizzle in `cause`
    expect(jobErrorCode(Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }))).toBe('invalid_input');
    expect(jobErrorCode(new Error('Failed query', { cause: Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }) }))).toBe('invalid_input');
  });
});
