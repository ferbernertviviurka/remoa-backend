import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { createApp, supabaseVerifier } from './app';
import { ensureBucket } from './storage/storage';
import { syncLegalVersions } from './account/legal';
import { createLogger } from '@remoa/log';
import { createMockStripe, createStripe, installStripe } from './billing/stripe';
import { grade as mockGrader } from '@remoa/contracts/mocks';
import { gradeAnswer, streamGradeAnswer } from './ai/service';
import { aiMode, missingConfig, validateAi } from '@remoa/ai';
import { env as configEnv } from '@remoa/config';
import { drainEmails } from './notifications/notify';
import { notificationEmailsInflight, startHourlyNotificationEmails } from './notifications/hourly-emails';
import { reconcileQuestionRuntime } from './questions/runtime/recovery';
import { questionFeatures,questionAdmissionLimits } from './questions/runtime/config';
import { warmUp } from './warmup';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false } });

// D-565: local JWT verification (JWKS from NEXT_PUBLIC_SUPABASE_URL/auth/v1/.well-known/jwks.json) + one DB session query per request.
// Mocks are fail-closed (G05 M3): only with NODE_ENV=development|test (the `dev` script sets it); an unset NODE_ENV counts as production.
const devLike = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
// G18 (D-732): e-mail/notification/cron settings validated before anything starts; throws EnvError listing what is missing.
const { webOrigins } = configEnv();
questionFeatures();questionAdmissionLimits(); // F33 fail at boot on malformed rollout/rate env
for (const k of ['GRADER', 'STRIPE', 'AI'] as const) if (process.env[k] === 'mock' && !devLike) throw new Error(`${k}=mock requires NODE_ENV=development or test`);
// D-580: map generation without OPENROUTER_API_KEY answers 503 ai_unavailable unless AI=mock (deterministic offline drafts). Said once at boot.
if (aiMode() !== 'live') createLogger({ requestId: 'boot' }).warn(aiMode() === 'mock' ? 'AI=mock: generated maps are offline drafts' : 'AI off: set the AI_* variables (or AI=mock in dev) to generate maps', { missing: missingConfig() });
// G22 (D-1407): model, fallbacks and key checked against the OpenRouter catalog in the background; problems go to the log and /health.
void validateAi();
// F05: OpenRouter when OPENROUTER_API_KEY is set; rubric-only grader otherwise. GRADER=mock keeps the deterministic test double.
const grade = process.env.GRADER === 'mock' ? mockGrader : gradeAnswer;
const stream = process.env.GRADER === 'mock' ? undefined : streamGradeAnswer;
// D-100: STRIPE=mock swaps the SDK for a fake with dev-only /v1/stripe/mock/* endpoints.
const mockStripe = process.env.STRIPE === 'mock' ? createMockStripe({ apiOrigin: `http://localhost:${process.env.PORT ?? 4000}` }) : undefined;
const stripe = mockStripe?.port ?? (process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin: webOrigins[0]! }) : undefined);
installStripe(stripe); // F18: grants/credits run from referral code and the webhook, not only routes
const deps = { grade, stream, stripe, mockStripe, webOrigin: webOrigins };
// D-1123: /health answers 503 until the pool is open and the hot routes' statements are prepared on every connection
const ready=warmUp(deps);
const app = createApp({ ...deps, verifyToken: supabaseVerifier(supabase), ready });

// P-430: the DB trigger records a sign-up acceptance only for the versions in legal_versions; publish the configured ones.
// D-1446: a stray rejected promise (e.g. a fire-and-forget job write) must not take the API down; log it and keep serving.
process.on('unhandledRejection', (e) => createLogger({ requestId: 'process' }).error('unhandled rejection', { error: e instanceof Error ? e.message : String(e) }));
syncLegalVersions().catch((e) => createLogger({ requestId: 'boot' }).error('legal versions not synced', { error: String(e) }));
const storageReady=ensureBucket();
storageReady.catch((e) => createLogger({ requestId: 'boot' }).error('storage bucket unavailable', { error: String(e) }));
void Promise.all([ready,storageReady]).then(()=>reconcileQuestionRuntime()).catch(()=>createLogger({requestId:"boot"}).error("question recovery failed at startup",{code:"question_recovery_failed"})); // F33 repository leases fence concurrent cron/startup attempts

const port = Number(process.env.PORT ?? 4000);
const server = serve({ fetch: app.fetch, port });
// D-1443: a 250 MB .apkg now streams through the API; Node's default 5 min for a whole request cuts slow connections. 15 min = Railway's cap.
(server as import('node:http').Server).requestTimeout = 15 * 60_000;
// Notification e-mails are due on the clock. Inngest and the Railway cron service are not running in production, so the API sweeps them every hour.
startHourlyNotificationEmails();
// D-992: deploys send SIGTERM; stop taking requests and give deferred e-mails (and a sweep already in flight) up to 8 s to leave.
process.once('SIGTERM', () => {
  server.close();
  void Promise.race([
    Promise.all([drainEmails(8_000), notificationEmailsInflight()]),
    new Promise((r) => setTimeout(r, 8_000)),
  ]).finally(() => process.exit(0));
});
process.stdout.write(`api on http://localhost:${port}\n`);
