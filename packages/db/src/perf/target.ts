// G21 T2 (D-985): perf tooling only ever touches an isolated database on the LOCAL Supabase Postgres, never `postgres`.
import { createHash, createHmac } from 'node:crypto';

export const DEFAULT_PERF_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/remoa_perf';
export const PG_CONTAINER = process.env.PERF_PG_CONTAINER ?? 'supabase_db_remoa';

/** Throws unless NODE_ENV is not production and the URL is a local database named remoa_perf*. */
export function perfTarget(): { url: string; db: string; adminUrl: string } {
  if (process.env.NODE_ENV === 'production') throw new Error('perf tooling refuses to run with NODE_ENV=production');
  const url = process.env.PERF_DATABASE_URL ?? DEFAULT_PERF_URL;
  const u = new URL(url);
  const db = u.pathname.slice(1);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error(`perf: refusing non-local host ${u.hostname}`);
  if (!/^remoa_perf[a-z0-9_]*$/.test(db)) throw new Error(`perf: target database must be named remoa_perf* (got "${db}"); never the shared postgres`);
  u.pathname = '/postgres';
  return { url, db, adminUrl: u.toString() };
}

/** md5(text)::uuid, same as the seed SQL. */
const md5 = (s: string) => {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
/** Deterministic id of perf user `i` (0 = admin, 1 = heavy user with 10k cards). */
export const userUuid = (i: number) => md5(`perf-user-${i}`);
export const sessionUuid = (i: number) => md5(`perf-session-${i}`);

const b64 = (o: object | Buffer) => Buffer.from(Buffer.isBuffer(o) ? o : JSON.stringify(o)).toString('base64url');
/** HS256 access token like GoTrue's (sub, session_id, amr for the admin 12 h window). */
export function perfToken(i: number, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userUuid(i), session_id: sessionUuid(i), role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 6 * 3600, amr: [{ method: 'password', timestamp: now }] })}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}
