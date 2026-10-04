import { Hono } from 'hono';
import { errorHttpStatus, onboardingAnswersPatchSchema, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { completeOnboarding, getOnboarding, saveOnboarding } from '../onboarding/onboarding';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

export const onboardingRoutes = new Hono<Env>()
  .get('/', async (c) => send(await getOnboarding(c.get('userId'))))
  .post('/answers', async (c) => {
    const body = onboardingAnswersPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return Response.json({ error: { code: 'validation', message: 'invalid answers' } } satisfies HttpErrorBody, { status: errorHttpStatus.validation });
    return send(await saveOnboarding(c.get('userId'), body.data));
  })
  .post('/complete', async (c) => send(await completeOnboarding(c.get('userId'))));
