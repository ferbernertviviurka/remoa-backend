// G21 T2 FR-5 (D-986): API for `pnpm perf:bench` only. Same createApp as index.ts, but the token is verified locally (HS256, SUPABASE_JWT_SECRET)
// and the session is checked with the production query (liveSession) against the isolated remoa_perf database; no Auth server involved.
// Refuses to start unless DATABASE_URL names a remoa_perf* database and NODE_ENV is development.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { grade as mockGrader } from '@remoa/contracts/mocks';
import { createApp, type VerifyToken } from '../app';
import { liveSession } from '../auth-session';

const dbName = new URL(process.env.DATABASE_URL ?? 'postgres://x/none').pathname.slice(1);
if (process.env.NODE_ENV !== 'development' || !/^remoa_perf[a-z0-9_]*$/.test(dbName)) throw new Error('perf server: needs NODE_ENV=development and DATABASE_URL on a remoa_perf* database');
const secret = process.env.SUPABASE_JWT_SECRET;
if (!secret) throw new Error('missing env SUPABASE_JWT_SECRET');

const verifyToken: VerifyToken = async (token, opts) => {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as { sub?: string; session_id?: string; exp?: number };
  if (!c.sub || !c.session_id || (c.exp ?? 0) * 1000 < Date.now()) return null;
  if (opts?.defer) return { userId: c.sub, sessionId: c.session_id, pending: true }; // D-990, same as supabaseVerifier
  const live = await liveSession(c.sub, c.session_id);
  return live && { userId: c.sub, sessionId: c.session_id, account: live.account };
};

const port = Number(process.env.PORT ?? 4300);
serve({ fetch: createApp({ verifyToken, webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', grade: mockGrader }).fetch, port });
process.stdout.write(`perf api on http://localhost:${port}\n`);
