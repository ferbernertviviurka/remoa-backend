import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { errorHttpStatus, type HttpErrorBody, type Result } from '@remoa/contracts';
import type { Env } from '../app';
import { requestMeta } from '../account/events';
import { changePassword } from '../account/password';
import { listSessions, revokeOtherSessions, revokeSession } from '../account/sessions';

const send = <T>(r: Result<T>) =>
  r.ok ? Response.json({ ok: true, data: r.data }) : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code] });

type SecEnv = { Variables: Env['Variables'] & { sid: string } };
/** These routes act relative to the caller's session: a token without `session_id` cannot use them (it would revoke everything). */
const needSession = createMiddleware<SecEnv>(async (c, next) => {
  const sid = c.get('sessionId');
  if (!sid) return send({ ok: false, error: { code: 'unauthorized', message: 'session required' } });
  c.set('sid', sid);
  await next();
});

/** F13 FR-9/FR-11. Mounted at /v1/account (requireUser). */
export const accountSecurityRoutes = new Hono<SecEnv>()
  .use('/password', needSession)
  .use('/sessions', needSession)
  .use('/sessions/*', needSession)
  .post('/password', async (c) => {
    const input = await c.req.json().catch(() => null);
    const accessToken = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    return send(await changePassword(c.get('userId'), c.get('sid'), input, { accessToken, meta: requestMeta(c) }));
  })
  .get('/sessions', async (c) => send(await listSessions(c.get('userId'), c.get('sid'))))
  .delete('/sessions/:id', async (c) => send(await revokeSession(c.get('userId'), c.get('sid'), c.req.param('id'), requestMeta(c))))
  .delete('/sessions', async (c) => send(await revokeOtherSessions(c.get('userId'), c.get('sid'), requestMeta(c))));
