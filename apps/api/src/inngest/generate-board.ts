import { runGeneration } from '../ai/service';
import { inngest } from './client';

/** F05 FR-5: board generation is an Inngest function. The API calls it via the event, or inline when Inngest is not configured. */
export const generateBoard = inngest.createFunction(
  { id: 'generate-board', retries: 0, triggers: [{ event: 'ai/board.generate' }] },
  async ({ event, step }) => {
    const data = event.data as { jobId?: string };
    const jobId = typeof data.jobId === 'string' ? data.jobId : '';
    return step.run('generate', async () => {
      await runGeneration(jobId);
      return { jobId };
    });
  },
);
