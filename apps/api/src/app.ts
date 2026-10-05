import { onboardingRoutes } from './routes/onboarding';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { supabaseVerifier, type Verified } from './auth-session';
import { adminErrors, errorHttpStatus, type AppError, type GradeAnswer, type HttpErrorBody } from '@remoa/contracts';
import { accountRoutes } from './routes/account';
import { accountSecurityRoutes } from './routes/account-security';
import { accountProfileRoutes } from './routes/account-profile';
import { publicRoutes } from './routes/public';
import { notificationsRoutes } from './notifications/routes';
import { calendarRoutes, publicCalendarRoutes } from './calendar/routes';
import { accountAvatarRoutes } from './routes/account-avatar';
import { accountState } from './admin/core';
import { adminRoutes } from './routes/admin';
import { caller } from './ai/caller';
import { billingRoutes } from './routes/billing';
import { stripeRoutes } from './routes/stripe';
import type { createMockStripe, StripePort } from './billing/stripe';
import { boardsRoutes } from './routes/boards';
import { cardsRoutes } from './routes/cards';
import { challengeRoutes, type GradeStream } from './routes/challenge';
import { coverageRoutes } from './routes/coverage';
import { homeRoutes } from './routes/home';
import { importsRoutes } from './routes/imports';
import { createImports, type AnkiPort } from './imports/imports';
import { ankiPort } from './imports/anki';
import { matrixRoutes } from './routes/matrix';
import { publicReferralRoutes, referralRoutes } from './routes/referral';
import { aiRoutes } from './routes/ai';
import { reportsRoutes } from './routes/reports';
import { editorialRoutes } from './routes/editorial';
import { reviewRoutes } from './routes/review';
import { supportRoutes } from './routes/support';
import { storeRoutes } from './routes/store';
import { assetsRoutes, uploadsRoutes } from './routes/uploads';
import { createLogger, newRequestId, type Logger } from '@remoa/log';
import { emailHealth } from '@remoa/config';
import { serve as serveInngest } from 'inngest/hono';
import { inngest } from './inngest/client';
import { generateBoard } from './inngest/generate-board';
import { maintenanceDaily, maintenanceHourly } from './inngest/maintenance';
import { noticeFunctions } from './inngest/notices';
import { cronRoutes } from './routes/cron';
import { authHookRoutes, devEmailsRoutes, emailsRoutes } from './emails/routes';
import { invalidateReviewHub } from './review/hub';

/** Resolves a Supabase access token to a user id (+ JWT `session_id`, D-124; + account flags, D-565), or null if invalid. A bare id = no session (tests). */
export type VerifyToken = (token: string) => Promise<string | Verified | null>;
export { supabaseVerifier };

/** D-123: the only routes a soft-deleted account (7-day grace) can still call. */
const DURING_DELETION = new Set(['GET /v1/account/me', 'POST /v1/account/deletion/cancel', 'POST /v1/account/export']);

export type Env = { Variables: { requestId: string; log: Logger; userId: string; sessionId: string | null } };

export const fail = (error: AppError) => Response.json({ error } satisfies HttpErrorBody, { status: errorHttpStatus[error.code] });

export function createApp({ verifyToken, webOrigin, grade, stream, stripe, mockStripe, anki }: { verifyToken: VerifyToken; webOrigin: string; grade?: GradeAnswer; stream?: GradeStream; stripe?: StripePort; mockStripe?: ReturnType<typeof createMockStripe>; anki?: AnkiPort }) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newRequestId();
    const log = createLogger({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    // D-643: an authenticated write can change cards, boards or the queue: drop this user's 60 s Revisar hub cache (one Map delete).
    // ponytail: async jobs that add cards later (Anki import, PDF generation) still show up within the 60 s TTL; invalidate at job end if that matters.
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.get('userId')) invalidateReviewHub(c.get('userId'));
    // F17: the share token is a credential; it never reaches the logs
    const line = { method: c.req.method, path: c.req.path.replace(/^(\/v1\/public\/(?:shared|referral|calendar(?:\/cover)?)\/)[^/]+/, '$1:token'), status: c.res.status, ms: Date.now() - start };
    if (c.res.status < 400) return log.info('request', line);
    // D-582: 4xx/5xx carry the typed error (`{ error: { code, message } }`, written by the API itself: no token, password or body echo).
    // The message only outside production: a zod message can quote a received value.
    const error = (await c.res.clone().json().catch(() => null) as HttpErrorBody | null)?.error;
    log[c.res.status >= 500 ? 'error' : 'warn']('request', { ...line, code: error?.code, ...(process.env.NODE_ENV === 'production' ? {} : { message: error?.message }) });
  });
  app.use('/v1/*', cors({ origin: webOrigin, credentials: true }));

  const requireUser = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '');
    const v = token ? await verifyToken(token) : null;
    const { userId, sessionId, account } = typeof v === 'string' ? { userId: v, sessionId: null } : (v ?? { userId: null, sessionId: null });
    if (!userId) return fail({ code: 'unauthorized', message: 'invalid or missing token' });
    if (account !== undefined || process.env.DATABASE_URL) {
      // D-565: the production verifier already read deletion (F08) + suspension (F19) in its session query; test verifiers do not
      const s = account !== undefined ? account : await accountState(userId);
      const route = `${c.req.method} ${c.req.path}`;
      if (s?.deletedAt && !DURING_DELETION.has(route)) return fail({ code: 'forbidden', message: 'account_deleted' }); // F08 FR-7 soft delete; D-123 exceptions
      if (s?.suspendedAt && route !== 'GET /v1/account/me') return fail({ code: 'forbidden', message: adminErrors.suspended }); // F19 D-430
    }
    c.set('userId', userId);
    c.set('sessionId', sessionId);
    return caller.run(userId, () => next());
  });

  app.get('/health', (c) => c.json({ ok: true, email: emailHealth() })); // G18: booleans only, no secret
  const inngestHandler = serveInngest({ client: inngest, functions: [generateBoard, maintenanceHourly, maintenanceDaily, ...noticeFunctions] });
  app.on(['GET', 'POST', 'PUT'], '/api/inngest', (c) => inngestHandler(c));
  // Lane routes mount under /v1 with requireUser (F02 uploads, F05 ai, F08 stripe webhook is public + signature).
  app.get('/v1/me', requireUser, (c) => c.json({ ok: true, data: { userId: c.get('userId') } }));

  app.use('/v1/account', requireUser).use('/v1/account/*', requireUser).route('/v1/account', accountRoutes({ stripe })).route('/v1/account', accountSecurityRoutes).route('/v1/account', accountAvatarRoutes);
  app.route('/v1/account', accountProfileRoutes()); // F13 profile/email/identities/preferences (requireUser applied above)
  const viewer = async (authorization: string | undefined) => {
    const token = authorization?.replace(/^Bearer /, '');
    const v = token ? await verifyToken(token).catch(() => null) : null;
    return typeof v === 'string' ? v : (v?.userId ?? null);
  };
  app.route('/v1/public/referral', publicReferralRoutes); // F18: no auth, rate limited per IP
  app.route('/v1/cron', cronRoutes); // G18: Bearer CRON_SECRET, same bodies as the Inngest crons
  app.route('/v1/emails', emailsRoutes); // G18 F24: Resend webhook (Svix signature) + one-click unsubscribe (signed token); no auth
  app.route('/v1/auth', authHookRoutes); // G18 F24: Supabase Auth Send Email hook (Standard Webhooks signature)
  app.route('/v1/dev/emails', devEmailsRoutes); // G18 F24 FR-19: preview for the web's /dev/emails; 404 in production
  app.route('/v1/public/calendar', publicCalendarRoutes); // G18 F25: .ics from the e-mail, HMAC token
  app.route('/v1/public', publicRoutes({ stripe, viewer })); // F13 unsubscribe: no auth, signed token; F17 shared links: optional session
  app.use('/v1/boards', requireUser).use('/v1/boards/*', requireUser).route('/v1/boards', boardsRoutes);

  app.use('/v1/cards', requireUser).use('/v1/cards/*', requireUser).route('/v1/cards', cardsRoutes);
  app.use('/v1/onboarding', requireUser).use('/v1/onboarding/*', requireUser).route('/v1/onboarding', onboardingRoutes); // F12
  app.use('/v1/notifications', requireUser).use('/v1/notifications/*', requireUser).route('/v1/notifications', notificationsRoutes); // G18 F26
  app.use('/v1/calendar', requireUser).use('/v1/calendar/*', requireUser).route('/v1/calendar', calendarRoutes); // G18 F25
  app.use('/v1/home', requireUser).route('/v1/home', homeRoutes);
  app.use('/v1/matrix/*', requireUser).route('/v1/matrix', matrixRoutes);
  app.use('/v1/coverage', requireUser).route('/v1/coverage', coverageRoutes);
  app.use('/v1/review', requireUser).use('/v1/review/*', requireUser).route('/v1/review', reviewRoutes);
  app.use('/v1/challenge', requireUser).use('/v1/challenge/*', requireUser).route('/v1/challenge', challengeRoutes({ grade, stream }));
  app.use('/v1/uploads', requireUser).use('/v1/uploads/*', requireUser).route('/v1/uploads', uploadsRoutes);
  app.use('/v1/imports/*', requireUser).route('/v1/imports', importsRoutes(createImports({ anki: anki ?? ankiPort }))); // F06 Anki import
  app.use('/v1/ai', requireUser).use('/v1/ai/*', requireUser).route('/v1/ai', aiRoutes);
  app.use('/v1/reports', requireUser).use('/v1/reports/*', requireUser).route('/v1/reports', reportsRoutes);
  app.use('/v1/editorial', requireUser).use('/v1/editorial/*', requireUser).route('/v1/editorial', editorialRoutes);
  app.use('/v1/assets', requireUser).use('/v1/assets/*', requireUser).route('/v1/assets', assetsRoutes);

  app.use('/v1/support/*', requireUser).route('/v1/support', supportRoutes); // F19
  app.use('/v1/store/*', requireUser).route('/v1/store', storeRoutes); // G16 store waitlist
  app.use('/v1/referral/*', requireUser).route('/v1/referral', referralRoutes); // F18
  app.use('/v1/billing/*', requireUser).route('/v1/billing', billingRoutes({ stripe }));
  app.route('/v1/stripe', stripeRoutes({ stripe, mock: mockStripe, webOrigin })); // public: signature / unguessable mock session
  app.route('/v1/admin', adminRoutes({ verifyToken })); // F19: requireAdmin inside (404 for non-admin, never 401/403)

  app.notFound(() => fail({ code: 'not_found', message: 'route not found' }));
  app.onError((e, c) => {
    c.get('log').error('unhandled', { error: e instanceof Error ? e.message : String(e) });
    return fail({ code: 'internal', message: 'internal error' });
  });
  return app;
}
