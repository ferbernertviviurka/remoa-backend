import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { createApp, supabaseVerifier } from './app';
import { ensureBucket } from './storage/storage';
import { createLogger } from '@remoa/log';
import { createMockStripe, createStripe } from './billing/stripe';
import { grade as mockGrader } from '@remoa/contracts/mocks';
import { gradeAnswer, streamGradeAnswer } from './ai/service';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false } });

// ponytail: one Auth round-trip per request; switch to local JWKS verification (jose) when latency matters.
// Mocks are fail-closed (G05 M3): only with NODE_ENV=development|test (the `dev` script sets it); an unset NODE_ENV counts as production.
const devLike = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
for (const k of ['GRADER', 'STRIPE'] as const) if (process.env[k] === 'mock' && !devLike) throw new Error(`${k}=mock requires NODE_ENV=development or test`);
// F05: OpenRouter when OPENROUTER_API_KEY is set; rubric-only grader otherwise. GRADER=mock keeps the deterministic test double.
const grade = process.env.GRADER === 'mock' ? mockGrader : gradeAnswer;
const stream = process.env.GRADER === 'mock' ? undefined : streamGradeAnswer;
// D-100: STRIPE=mock swaps the SDK for a fake with dev-only /v1/stripe/mock/* endpoints.
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const mockStripe = process.env.STRIPE === 'mock' ? createMockStripe({ apiOrigin: `http://localhost:${process.env.PORT ?? 4000}` }) : undefined;
const stripe = mockStripe?.port ?? (process.env.STRIPE_SECRET ? createStripe({ secret: process.env.STRIPE_SECRET, webOrigin }) : undefined);
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
