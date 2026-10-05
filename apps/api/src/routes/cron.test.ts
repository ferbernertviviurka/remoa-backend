import { describe, expect, it, vi } from 'vitest';

const ran = vi.hoisted(() => vi.fn(async () => 7));
vi.mock('../inngest/notices', () => ({
  noticeJobs: { 'notifications.retention': { cron: '30 6 * * *', run: ran } },
  isNoticeJob: (s: string) => s === 'notifications.retention',
  noticeFunctions: [],
}));

import { env } from '@remoa/config';
import { createApp } from '../app';

const app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async () => null });
const post = (job: string, authorization?: string) =>
  app.request(`/v1/cron/${job}`, { method: 'POST', headers: authorization ? { authorization } : {} });

describe('POST /v1/cron/:job (G18)', () => {
  it('needs the exact Bearer CRON_SECRET', async () => {
    const secret = env().cronSecret;
    for (const h of [undefined, 'Bearer nope', secret, `Bearer ${secret}x`, `bearer ${secret}`]) expect((await post('notifications.retention', h)).status).toBe(401);
    expect(ran).not.toHaveBeenCalled();
  });

  it('runs a known job with the same body as Inngest; unknown jobs are 404', async () => {
    const auth = `Bearer ${env().cronSecret}`;
    expect((await post('nope', auth)).status).toBe(404);
    const res = await post('notifications.retention', auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { job: 'notifications.retention', result: 7 } });
    expect(ran).toHaveBeenCalledTimes(1);
  });
});
