import { runGeneration } from '../ai/service';
import { inngest } from './client';

/**
 * F05 FR-5 / G22 (D-1415): board generation is an Inngest function over the ai_jobs row (state in Postgres, so any process runs
 * it). The API calls it via the event, or inline when Inngest is not configured. `retries: 0`: a failure ends the job and gives
 * the unit back; the student retries (POST /v1/ai/jobs/:id/retry). `cancelOn` stops a run when the job is canceled.
 */
export const generateBoard = inngest.createFunction(
  { id: 'generate-board', retries: 0, triggers: [{ event: 'ai/board.generate' }], cancelOn: [{ event: 'ai/board.cancel', match: 'data.jobId' }] },
  async ({ event, step }) => {
    const data = event.data as { jobId?: string };
    const jobId = typeof data.jobId === 'string' ? data.jobId : '';
    return step.run('generate', async () => {
      await runGeneration(jobId);
      return { jobId };
    });
  },
);
