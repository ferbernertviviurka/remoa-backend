import { runDaily, runHourly } from '../account/maintenance';
import { inngest } from './client';

/** F08 FR-8: the maintenance sweep on a real schedule. Bodies are idempotent, so a retry or a double run is safe. */
export const maintenanceHourly = inngest.createFunction(
  { id: 'maintenance-hourly', retries: 1, concurrency: 1, triggers: [{ cron: '0 * * * *' }] },
  async ({ step }) => step.run('hourly', () => runHourly()),
);

export const maintenanceDaily = inngest.createFunction(
  { id: 'maintenance-daily', retries: 1, concurrency: 1, triggers: [{ cron: '0 6 * * *' }] },
  async ({ step }) => step.run('daily', () => runDaily()),
);
