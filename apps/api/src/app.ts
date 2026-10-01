import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { errorHttpStatus, type AppError, type HttpErrorBody } from '@remoa/contracts';
import { boardsRoutes } from './routes/boards';
import { createLogger, newRequestId, type Logger } from '@remoa/log';

/** Resolves a Supabase access token to a user id, or null if invalid. */
export type VerifyToken = (token: string) => Promise<string | null>;

export type Env = { Variables: { requestId: string; log: Logger; userId: string } };

export const fail = (error: AppError) => Response.json({ error } satisfies HttpErrorBody, { status: errorHttpStatus[error.code] });

export function createApp({ verifyToken, webOrigin }: { verifyToken: VerifyToken; webOrigin: string }) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newRequestId();
    const log = createLogger({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    log.info('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start });
  });
  app.use('/v1/*', cors({ origin: webOrigin, credentials: true }));

  const requireUser = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    const userId = token ? await verifyToken(token) : null;
    if (!userId) return fail({ code: 'unauthorized', message: 'invalid or missing token' });
    c.set('userId', userId);
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));
  // Lane routes mount under /v1 with requireUser (F02 uploads, F05 ai, F08 stripe webhook is public + signature).
  app.get('/v1/me', requireUser, (c) => c.json({ ok: true, data: { userId: c.get('userId') } }));

  app.use('/v1/boards', requireUser).use('/v1/boards/*', requireUser).route('/v1/boards', boardsRoutes);

  app.notFound(() => fail({ code: 'not_found', message: 'route not found' }));
  app.onError((e, c) => {
    c.get('log').error('unhandled', { error: e instanceof Error ? e.message : String(e) });
    return fail({ code: 'internal', message: 'internal error' });
  });
  return app;
}
