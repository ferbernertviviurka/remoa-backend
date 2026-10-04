import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'remoa',
  eventKey: process.env.INNGEST_EVENT_KEY,
  isDev: process.env.NODE_ENV !== 'production',
});

/** The job runs through Inngest only when a key or the dev server flag is set. Otherwise the API runs the same function inline. */
export function inngestConfigured(): boolean {
  return Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV === '1');
}

export async function dispatchBoardJob(jobId: string): Promise<boolean> {
  if (!inngestConfigured()) return false;
  await inngest.send({ name: 'ai/board.generate', data: { jobId } });
  return true;
}
