import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app';
import { ensureBucket } from './storage/storage';
import { createLogger } from '@remoa/log';
import { grade as mockGrader } from '@remoa/contracts/mocks';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false } });

// ponytail: one Auth round-trip per request; switch to local JWKS verification (jose) when latency matters.
// D-061: no real grader until F05. GRADER=mock (dev/e2e only, ignored in production) injects the contracts mock grader.
const grade = process.env.GRADER === 'mock' && process.env.NODE_ENV !== 'production' ? mockGrader : undefined;
const app = createApp({
  grade,
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  verifyToken: async (token) => (await supabase.auth.getUser(token)).data.user?.id ?? null,
});

ensureBucket().catch((e) => createLogger({ requestId: 'boot' }).error('storage bucket unavailable', { error: String(e) }));

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port });
process.stdout.write(`api on http://localhost:${port}\n`);
