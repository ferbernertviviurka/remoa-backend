import { createLogger } from '@remoa/log';
import { createApp } from './app';
import { warmPool, warmStatements } from './db';

/** The first wave of /app (layout + shell + Hoje, D-1122) and the next screens a student opens. */
export const HOT_PATHS = [
  '/v1/account/me', '/v1/onboarding', '/v1/billing/entitlements', '/v1/boards', '/v1/boards?include=preview', '/v1/review/hub',
  '/v1/review/queue?limit=1', '/v1/review/queue', '/v1/calendar/upcoming?limit=4', '/v1/calendar/settings',
  '/v1/notifications/unread-count', '/v1/support/unread', '/v1/home', '/v1/coverage',
];
const NIL = '00000000-0000-0000-0000-000000000000';
export const WARM_CAP_MS = 60_000; // Railway healthcheckTimeout is 120 s (railway.json)

/**
 * D-1123 (P-541 d): before the API takes traffic, open the pool (D-1096) and send the hot routes once through the real handlers, as a
 * user that does not exist (nil uuid: empty answers, nothing written), so run() learns their exact statement texts; then prepare them
 * on every pooled connection (D-1106). The warm app is never served: its verifier only exists in this process. `s` = the deferred
 * session check of a real GET (first statement with the session join), `n` = no session (the route runs to its end).
 * Returns `ready()`: true when done, failed, or after `capMs` (a slow database never keeps the API down).
 * ponytail: statements behind data-dependent branches (a user with boards, a stale map_stats) stay cold for their first user.
 * ponytail: the cap only flips readiness; it does not cancel `work`. With a database slow enough to pass the cap, warmStatements still
 * holds every connection until its prepares return, and early traffic queues behind them (releasing early would not help: the queued
 * prepares stay on those connections). Upgrade if that ever shows up: a per-statement timeout in shareStatements.
 */
export function warmUp(deps: Omit<Parameters<typeof createApp>[0], 'verifyToken' | 'ready'>, capMs = WARM_CAP_MS): () => boolean {
  let ready = false;
  const log = createLogger({ requestId: 'boot' });
  const t0 = Date.now();
  const app = createApp({ ...deps, verifyToken: async (t) => (t === 's' ? { userId: NIL, sessionId: NIL, pending: true } : { userId: NIL, sessionId: null, account: null }) });
  const hit = (path: string, t: 's' | 'n') => Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${t}`, 'x-request-id': 'warm-up' } })).then((r) => r.arrayBuffer()).catch(() => undefined);
  const work = (async () => {
    await warmPool();
    await Promise.all([...HOT_PATHS.map((p) => hit(p, 'n')), hit('/v1/home', 's')]);
    await warmStatements();
  })();
  const cap = new Promise<void>((resolve) => setTimeout(resolve, capMs).unref());
  Promise.race([work.then(() => log.info('warm-up done', { ms: Date.now() - t0 })), cap.then(() => log.warn('warm-up cap reached', { ms: capMs }))])
    .catch((e: unknown) => log.error('warm-up failed', { error: e instanceof Error ? e.message : String(e) }))
    .finally(() => (ready = true));
  return () => ready;
}
