import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { createApp, supabaseVerifier } from './app';
import { ensureBucket } from './storage/storage';
import { createLogger } from '@remoa/log';
import { createMockStripe, createStripe, installStripe } from './billing/stripe';
import { grade as mockGrader } from '@remoa/contracts/mocks';
import { gradeAnswer, streamGradeAnswer } from './ai/service';
import { aiMode } from '@remoa/ai';
import { env as configEnv } from '@remoa/config';

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
configEnv();
for (const k of ['GRADER', 'STRIPE', 'AI'] as const) if (process.env[k] === 'mock' && !devLike) throw new Error(`${k}=mock requires NODE_ENV=development or test`);
// D-580: map generation without OPENROUTER_API_KEY answers 503 ai_unavailable unless AI=mock (deterministic offline drafts). Said once at boot.
if (aiMode() !== 'live') createLogger({ requestId: 'boot' }).warn(aiMode() === 'mock' ? 'AI=mock: generated maps are offline drafts' : 'AI off: set OPENROUTER_API_KEY (or AI=mock in dev) to generate maps');
// F05: OpenRouter when OPENROUTER_API_KEY is set; rubric-only grader otherwise. GRADER=mock keeps the deterministic test double.
const grade = process.env.GRADER === 'mock' ? mockGrader : gradeAnswer;
const stream = process.env.GRADER === 'mock' ? undefined : streamGradeAnswer;
// D-100: STRIPE=mock swaps the SDK for a fake with dev-only /v1/stripe/mock/* endpoints.
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const mockStripe = process.env.STRIPE === 'mock' ? createMockStripe({ apiOrigin: `http://localhost:${process.env.PORT ?? 4000}` }) : undefined;
const stripe = mockStripe?.port ?? (process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin }) : undefined);
installStripe(stripe); // F18: grants/credits run from referral code and the webhook, not only routes
const app = createApp({
  grade,
  stream,
  stripe,
  mockStripe,
  webOrigin,
  verifyToken: supabaseVerifier(supabase),
});

ensureBucket().catch((e) => createLogger({ requestId: 'boot' }).error('storage bucket unavailable', { error: String(e) }));

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port });
process.stdout.write(`api on http://localhost:${port}\n`);
