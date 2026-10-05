// G18: POST /v1/cron/:job — the Inngest job bodies for an external cron (Railway). `Authorization: Bearer ${CRON_SECRET}`.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '@remoa/config';
import { fail, type Env } from '../app';
import { isNoticeJob, noticeJobs } from '../inngest/notices';

// Digests first: equal length, so the comparison is constant-time whatever the header holds.
const digest = (s: string) => createHash('sha256').update(s).digest();
const authorized = (header: string | undefined) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${env().cronSecret}`));

export const cronRoutes = new Hono<Env>().post('/:job', async (c) => {
  if (!authorized(c.req.header('authorization'))) return fail({ code: 'unauthorized', message: 'invalid cron secret' });
  const job = c.req.param('job');
  if (!isNoticeJob(job)) return fail({ code: 'not_found', message: 'unknown job' });
  const result = await noticeJobs[job].run(new Date());
  c.get('log').info('cron job done', { job, result });
  return c.json({ ok: true, data: { job, result } });
});
