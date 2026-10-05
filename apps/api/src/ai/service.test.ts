import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowGrade, generationOf, startGeneration, startPdfGeneration } from './service';

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

  it('AI=mock wins over a configured key: deterministic draft, no provider call', async () => {
    process.env.OPENROUTER_API_KEY = 'would-call-openrouter';
    delete process.env.DATABASE_URL;
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_DEV;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const started = await startGeneration('ai-mock-user', { kind: 'text', title: 'Sepse', area: 'CM', text: 'Sepse. Disfuncao organica por infeccao.\n\nChoque septico. Hipotensao refrataria a volume.' } as Parameters<typeof startGeneration>[1]);
    expect(started.ok).toBe(true);
    if (!started.ok || !('data' in started)) return;
    let job = generationOf('ai-mock-user', started.data.jobId);
    for (let i = 0; i < 100 && job?.status !== 'done' && job?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = generationOf('ai-mock-user', started.data.jobId);
    }
    expect(job).toMatchObject({ status: 'done', error: null });
    expect(job?.cards).toBeGreaterThan(0);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('openrouter'))).toBe(false);
  });
});

describe('pdf generation job', () => {
  it('fails an unreadable PDF without leaving the job running', async () => {
    const user = 'pdf-unreadable-user';
    const started = await startPdfGeneration(user, pdfBoard, new TextEncoder().encode('curto'));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let job = generationOf(user, started.data.jobId);
    for (let i = 0; i < 30 && job?.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      job = generationOf(user, started.data.jobId);
    }
    expect(job).toMatchObject({ status: 'failed', error: 'pdf_unreadable' });
  });

  it('turns a 20-page PDF into a map with progress from the start to 100 in under 90 seconds', async () => {
    const prev = {
      DATABASE_URL: process.env.DATABASE_URL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
      INNGEST_DEV: process.env.INNGEST_DEV,
    };
    delete process.env.DATABASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_DEV;
    const outline = [
      'Sepse.',
      'Disfuncao organica por infeccao que exige reconhecimento clinico.',
      '',
      'Fluxo: Conduta de sepse',
      '1. Reconhecer a disfuncao organica',
      '2. Reavaliar o pacote inicial',
      '',
      'Caso: Caso de sepse',
      'Apresentacao: febre e hipotensao',
      'Conduta: reconhecer e reavaliar',
    ].join('\n');
    const literal = `(${outline.replace(/[()\\]/g, (ch) => `\\${ch}`).replace(/\n/g, '\\n')}) Tj`;
    const bytes = new TextEncoder().encode(`${'/Type /Page '.repeat(20)}${literal}`);
    const startedAt = Date.now();
    try {
      const started = await startPdfGeneration('pdf-twenty-user', pdfBoard, bytes);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const seen = new Set<number>();
      let job = generationOf('pdf-twenty-user', started.data.jobId);
      while (job && job.status !== 'done' && job.status !== 'failed' && Date.now() - startedAt < 5_000) {
        seen.add(job.progress);
        await new Promise((resolve) => setTimeout(resolve, 5));
        job = generationOf('pdf-twenty-user', started.data.jobId);
      }
      expect(Date.now() - startedAt).toBeLessThan(90_000);
      expect(job).toMatchObject({ status: 'done', progress: 100, pages: 20 });
      expect(job?.cards).toBeGreaterThan(0);
      expect([...seen].some((n) => n < 100)).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
