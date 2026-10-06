// F27 FR-21/FR-33 (D-907): ask the web to drop its tag cache. Best effort: never throws, never fails the caller's action.
import { env } from '@remoa/config';
import { revalidateInputSchema } from '@remoa/contracts';
import { createLogger, newRequestId, type Logger } from '@remoa/log';

const TIMEOUT_MS = 3000;
const ATTEMPTS = 2; // one retry

/** POST REVALIDATE_URL with Bearer REVALIDATE_SECRET. Tags are de-duplicated and capped at the contract's 50. */
export async function revalidateBlog(tags: string[], log: Logger = createLogger({ requestId: newRequestId() })): Promise<void> {
  const parsed = revalidateInputSchema.safeParse({ tags: [...new Set(tags)].slice(0, 50) });
  if (!parsed.success) return log.warn('blog revalidate skipped', { reason: 'invalid tags' });
  let cfg: ReturnType<typeof env>;
  try {
    cfg = env();
  } catch (e) {
    return log.error('blog revalidate failed', { error: e instanceof Error ? e.message : String(e) });
  }
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(cfg.revalidateUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.revalidateSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return log.info('blog revalidated', { tags: parsed.data.tags, attempt });
      last = `status ${res.status}`;
      if (res.status < 500) break; // 401/422 will not get better on retry
    } catch (e) {
      last = e instanceof Error ? e.name : String(e);
    }
  }
  log.error('blog revalidate failed', { tags: parsed.data.tags, error: last });
}
