// G18: POST /v1/cron/:job — the Inngest job bodies for an external cron (Railway). `Authorization: Bearer ${CRON_SECRET}`.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '@remoa/config';
import { fail, type Env } from '../app';
import { isNoticeJob, noticeJobs } from '../inngest/notices';
import { CAMPAIGN_EXPIRES_AT, CAMPAIGN_ID, campaignAuthorization, campaignEnrollment, publishCampaign } from '../blog/campaign';

// Digests first: equal length, so the comparison is constant-time whatever the header holds.
const digest = (s: string) => createHash('sha256').update(s).digest();
const authorized = (header: string | undefined) => timingSafeEqual(digest(header ?? ''), digest(`Bearer ${env().cronSecret}`));

export const cronRoutes = new Hono<Env>().post('/blog.campaign-2026-10', async (c) => {
  const auth = campaignAuthorization(c.req.header('authorization'));
  if (auth === 'disabled') return c.json({ ok: false, error: { code: 'unavailable', message: 'campaign publisher disabled' } }, 503);
  if (auth !== 'authorized') return fail({ code: 'unauthorized', message: 'invalid campaign secret' });
  // Inputs never choose the scope or the clock. Reject rather than silently ignoring them.
  if (new URL(c.req.url).search || (await c.req.text()).length) return c.json({ ok: false, error: { code: 'validation', message: 'no input allowed' } }, 400);
  const now = new Date();
  if (now.getTime() >= CAMPAIGN_EXPIRES_AT) return c.json({ ok: false, error: { code: 'expired', message: 'campaign expired' } }, 410);
  const enrollment = campaignEnrollment(process.env.BLOG_CAMPAIGN_2026_10_ENROLLMENT);
  if (!enrollment) return c.json({ ok: false, error: { code: 'unavailable', message: 'campaign publisher disabled' } }, 503);
  const result = await publishCampaign(now, enrollment);
  return c.json({ ok: true, data: { campaignId: CAMPAIGN_ID, ...result } });
}).post('/:job', async (c) => {
  if (!authorized(c.req.header('authorization'))) return fail({ code: 'unauthorized', message: 'invalid cron secret' });
  const job = c.req.param('job');
  if (!isNoticeJob(job)) return fail({ code: 'not_found', message: 'unknown job' });
  const result = await noticeJobs[job].run(new Date());
  c.get('log').info('cron job done', { job, result });
  return c.json({ ok: true, data: { job, result } });
});
