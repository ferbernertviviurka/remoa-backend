import { serve } from '@hono/node-server';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const supabase = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false } });

// ponytail: one Auth round-trip per request; switch to local JWKS verification (jose) when latency matters.
const app = createApp({
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  verifyToken: async (token) => (await supabase.auth.getUser(token)).data.user?.id ?? null,
});

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port });
process.stdout.write(`api on http://localhost:${port}\n`);
