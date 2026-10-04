import { describe, expect, it } from 'vitest';
import { allowGrade, generationOf, startPdfGeneration } from './service';

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
