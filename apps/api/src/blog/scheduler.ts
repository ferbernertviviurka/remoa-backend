// The API is a persistent Railway process. Keep scheduling alive without an external cron or Inngest registration.
import { createLogger } from '@remoa/log';
import { asJob } from '../db';
import { publishScheduled } from '../inngest/blog';

export const BLOG_SWEEP_MS = 5 * 60_000;
const log = createLogger({ requestId: 'job-blog-scheduled' });

export function msUntilNextBlogSweep(now = Date.now()) {
  const remainder = now % BLOG_SWEEP_MS;
  return remainder === 0 ? BLOG_SWEEP_MS : BLOG_SWEEP_MS - remainder;
}

let started = false;
let inflight: Promise<unknown> = Promise.resolve();
export const blogSchedulerInflight = () => inflight;

/** Start once at boot and at five-minute UTC boundaries. SQL's status predicate fences concurrent replicas/cron. */
export function startBlogScheduler(run: (now: Date) => Promise<unknown> = publishScheduled) {
  if (started) return () => undefined;
  started = true;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = true;
    inflight = Promise.resolve().then(() => asJob(() => run(new Date())))
      .catch((e: unknown) => log.error('scheduled blog publication failed', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { running = false; });
  };
  const arm = () => {
    timer = setTimeout(() => {
      tick();
      if (!stopped) arm();
    }, msUntilNextBlogSweep());
    timer.unref?.();
  };
  tick();
  arm();
  return () => {
    stopped = true;
    started = false;
    if (timer) clearTimeout(timer);
  };
}
