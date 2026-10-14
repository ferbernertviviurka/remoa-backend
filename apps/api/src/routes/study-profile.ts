// G28-P / F35 routes. Public reference (no auth, per-IP limit) and the owner's study profile under /v1/account/study-profile.
import { Hono } from 'hono';
import {
  err, errorHttpStatus, institutionsQuerySchema, normalizeSearch, parseWith, referenceSuggestionInputSchema, studyGoalsQuerySchema, studyProfileInputSchema,
  type HttpErrorBody, type Result,
} from '@remoa/contracts';
import { clientIp } from '../client-ip';
import { takeViewSlot } from '../public/shared';
import type { Env } from '../app';
import { listCourses, listGoals, searchInstitutions } from '../study-profile/reference';
import { getStudyProfile, putStudyProfile, suggestReference, takeSuggestionSlot } from '../study-profile/profile';

const send = <T>(r: Result<T>, headers?: Record<string, string>) =>
  r.ok ? Response.json({ ok: true, data: r.data }, { headers }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });
const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
// Courses and goals change only on deploy (seed): browsers and the CDN may keep them.
const STATIC = { 'cache-control': 'public, max-age=3600' };

/** Mounted at /v1/public/reference. 60 requests per minute per IP (shared in-memory limiter, bucket per route family). */
export const publicReferenceRoutes = () =>
  new Hono()
    .use(async (c, next) => (takeViewSlot(`ref:${clientIp(c)}`) ? next() : send(err('rate_limited', 'too many requests'))))
    .get('/courses', async () => send(await listCourses(), STATIC))
    .get('/goals', async (c) => {
      const q = parseWith(studyGoalsQuerySchema, { course: c.req.query('course') });
      return send(q.ok ? await listGoals(q.data.course) : q, STATIC);
    })
    .get('/institutions', async (c) => {
      const q = parseWith(institutionsQuerySchema, c.req.query());
      return send(q.ok ? await searchInstitutions(q.data) : q);
    });

/** Mounted at /v1/account (requireUser applied in app.ts). */
export const studyProfileRoutes = () =>
  new Hono<Env>()
    .get('/study-profile', async (c) => send(await getStudyProfile(c.get('userId'))))
    .put('/study-profile', (c) => save(c))
    .post('/study-profile/confirm', (c) => save(c))
    .post('/study-profile/suggestions', async (c) => {
      const i = parseWith(referenceSuggestionInputSchema, await body(c));
      if (!i.ok) return send(i);
      if (!takeSuggestionSlot(c.get('userId'))) return send(err('rate_limited', 'too many suggestions'));
      await suggestReference(i.data.kind, i.data.text, normalizeSearch(i.data.text));
      return send({ ok: true, data: null });
    });

async function save(c: import('hono').Context<Env>) {
  const i = parseWith(studyProfileInputSchema, await body(c));
  if (!i.ok) return send(i);
  const r = await putStudyProfile(c.get('userId'), i.data);
  // FR telemetry: codes only, never free text
  if (r.ok) c.get('log').info('study_profile_saved', { course: i.data.course, situation: i.data.situation });
  return send(r);
}
