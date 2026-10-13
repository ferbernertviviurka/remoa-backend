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
 * The cap stops new warm requests and cancels pool/prepare work cooperatively. Readiness after a cap or failure means degraded
 * startup (ordinary requests can still fail), not successful warming. At most one synthetic request is active at a time.
 */
export function warmUp(deps: Omit<Parameters<typeof createApp>[0], 'verifyToken' | 'ready'>, capMs = WARM_CAP_MS): () => boolean {
  let ready = false;
  const log = createLogger({ requestId: 'boot' });
  const t0 = Date.now();
  const app = createApp({ ...deps, verifyToken: async (t) => (t === 's' ? { userId: NIL, sessionId: NIL, pending: true } : { userId: NIL, sessionId: null, account: null }) });
  const controller = new AbortController();
  const { signal } = controller;
  const cap = setTimeout(() => {
    controller.abort();
    ready = true;
    log.warn('warm-up cap reached', { ms: capMs, degraded: true });
  }, capMs);
  cap.unref();
  const hit = async (path: string, t: 's' | 'n') => {
    signal.throwIfAborted();
    try {
      const r = await app.request(path, { signal, headers: { authorization: `Bearer ${t}`, 'x-request-id': 'warm-up' } });
      await r.arrayBuffer();
    } catch (e) {
      if (signal.aborted) throw e;
      // A route unavailable to the synthetic account must not prevent warming the next one.
    }
    signal.throwIfAborted();
  };
  const work = (async () => {
    await warmPool(signal);
    signal.throwIfAborted();
    for (const path of HOT_PATHS) await hit(path, 'n');
    await hit('/v1/home', 's');
    signal.throwIfAborted();
    await warmStatements(signal);
  })();
  void work.then(() => {
    if (!signal.aborted) log.info('warm-up done', { ms: Date.now() - t0 });
  }).catch((e: unknown) => {
    if (!signal.aborted) log.error('warm-up failed', { error: e instanceof Error ? e.message : String(e), degraded: true });
  }).finally(() => {
    clearTimeout(cap);
    ready = true;
  });
  return () => ready;
}
