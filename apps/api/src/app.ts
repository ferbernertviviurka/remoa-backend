import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorHttpStatus, type AppError, type GradeAnswer, type HttpErrorBody } from '@remoa/contracts';
import { accountRoutes } from './routes/account';
import { accountSecurityRoutes } from './routes/account-security';
import { accountProfileRoutes } from './routes/account-profile';
import { publicRoutes } from './routes/public';
import { accountAvatarRoutes } from './routes/account-avatar';
import { isAccountDeleted } from './account/account';
import { billingRoutes } from './routes/billing';
import { stripeRoutes } from './routes/stripe';
import type { createMockStripe, StripePort } from './billing/stripe';
import { boardsRoutes } from './routes/boards';
import { cardsRoutes } from './routes/cards';
import { challengeRoutes } from './routes/challenge';
import { coverageRoutes } from './routes/coverage';
import { homeRoutes } from './routes/home';
import { matrixRoutes } from './routes/matrix';
import { reviewRoutes } from './routes/review';
import { assetsRoutes, uploadsRoutes } from './routes/uploads';
import { createLogger, newRequestId, type Logger } from '@remoa/log';

/** Resolves a Supabase access token to a user id (+ JWT `session_id`, D-124), or null if invalid. A bare id = no session (tests). */
export type VerifyToken = (token: string) => Promise<string | { userId: string; sessionId: string | null } | null>;

/** Production verifier: getUser() validates the token and that its session still exists, so the claims read after it are trusted. */
export const supabaseVerifier = (client: SupabaseClient): VerifyToken => async (token) => {
  const id = (await client.auth.getUser(token)).data.user?.id;
  if (!id) return null;
  try {
    const sid = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).session_id;
    return { userId: id, sessionId: typeof sid === 'string' ? sid : null };
  } catch {
    return { userId: id, sessionId: null };
  }
};

/** D-123: the only routes a soft-deleted account (7-day grace) can still call. */
const DURING_DELETION = new Set(['GET /v1/account/me', 'POST /v1/account/deletion/cancel', 'POST /v1/account/export']);

export type Env = { Variables: { requestId: string; log: Logger; userId: string; sessionId: string | null } };

export const fail = (error: AppError) => Response.json({ error } satisfies HttpErrorBody, { status: errorHttpStatus[error.code] });

export function createApp({ verifyToken, webOrigin, grade, stripe, mockStripe }: { verifyToken: VerifyToken; webOrigin: string; grade?: GradeAnswer; stripe?: StripePort; mockStripe?: ReturnType<typeof createMockStripe> }) {
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
    const v = token ? await verifyToken(token) : null;
    const { userId, sessionId } = typeof v === 'string' ? { userId: v, sessionId: null } : (v ?? { userId: null, sessionId: null });
    if (!userId) return fail({ code: 'unauthorized', message: 'invalid or missing token' });
    if (process.env.DATABASE_URL && !DURING_DELETION.has(`${c.req.method} ${c.req.path}`) && (await isAccountDeleted(userId)))
      return fail({ code: 'forbidden', message: 'account_deleted' }); // F08 FR-7 soft delete; D-123 exceptions
    c.set('userId', userId);
    c.set('sessionId', sessionId);
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));
  // Lane routes mount under /v1 with requireUser (F02 uploads, F05 ai, F08 stripe webhook is public + signature).
  app.get('/v1/me', requireUser, (c) => c.json({ ok: true, data: { userId: c.get('userId') } }));

  app.use('/v1/account', requireUser).use('/v1/account/*', requireUser).route('/v1/account', accountRoutes({ stripe })).route('/v1/account', accountSecurityRoutes).route('/v1/account', accountAvatarRoutes);
  app.route('/v1/account', accountProfileRoutes()); // F13 profile/email/identities/preferences (requireUser applied above)
  app.route('/v1/public', publicRoutes()); // F13 unsubscribe: no auth, signed token
  app.use('/v1/boards', requireUser).use('/v1/boards/*', requireUser).route('/v1/boards', boardsRoutes);

  app.use('/v1/cards', requireUser).use('/v1/cards/*', requireUser).route('/v1/cards', cardsRoutes);
  app.use('/v1/home', requireUser).route('/v1/home', homeRoutes);
  app.use('/v1/matrix/*', requireUser).route('/v1/matrix', matrixRoutes);
  app.use('/v1/coverage', requireUser).route('/v1/coverage', coverageRoutes);
  app.use('/v1/review', requireUser).use('/v1/review/*', requireUser).route('/v1/review', reviewRoutes);
  app.use('/v1/challenge', requireUser).use('/v1/challenge/*', requireUser).route('/v1/challenge', challengeRoutes({ grade }));
  app.use('/v1/uploads', requireUser).use('/v1/uploads/*', requireUser).route('/v1/uploads', uploadsRoutes);
  app.use('/v1/assets', requireUser).use('/v1/assets/*', requireUser).route('/v1/assets', assetsRoutes);

  app.use('/v1/billing/*', requireUser).route('/v1/billing', billingRoutes({ stripe }));
  app.route('/v1/stripe', stripeRoutes({ stripe, mock: mockStripe, webOrigin })); // public: signature / unguessable mock session

  app.notFound(() => fail({ code: 'not_found', message: 'route not found' }));
  app.onError((e, c) => {
    c.get('log').error('unhandled', { error: e instanceof Error ? e.message : String(e) });
    return fail({ code: 'internal', message: 'internal error' });
  });
  return app;
}
