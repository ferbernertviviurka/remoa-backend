import { describe, expect, it } from 'vitest';
import { allowGrade, generationOf, startPdfGeneration } from './service';

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
    const started = startPdfGeneration(user, 'Sepse', new TextEncoder().encode('curto'));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let job = generationOf(user, started.data.jobId);
    for (let i = 0; i < 30 && job?.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      job = generationOf(user, started.data.jobId);
    }
    expect(job).toMatchObject({ status: 'failed', error: 'pdf_unreadable' });
  });
});
