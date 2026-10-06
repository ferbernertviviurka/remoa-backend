// G21/F29 T6 (D-980), generalized from F27's revalidateBlog (D-907): ask the web to drop Data Cache tags.
// POST REVALIDATE_URL (default `${SITE_URL}/api/revalidate`) with Bearer REVALIDATE_SECRET. Best effort: 3 s timeout, one retry, never throws.
import { env } from '@remoa/config';
import { revalidateInputSchema } from '@remoa/contracts';
import { createLogger, newRequestId, type Logger } from '@remoa/log';

const TIMEOUT_MS = 3000;
const ATTEMPTS = 2; // one retry
const MAX_TAGS = 50; // the web route's contract limit; more tags go in several posts

export async function revalidateWeb(tags: string[], log: Logger = createLogger({ requestId: newRequestId() })): Promise<void> {
  const all = [...new Set(tags)];
  if (!all.length) return log.warn('web revalidate skipped', { reason: 'invalid tags' });
  for (let i = 0; i < all.length; i += MAX_TAGS) await post(all.slice(i, i + MAX_TAGS), log);
}

async function post(tags: string[], log: Logger): Promise<void> {
  const parsed = revalidateInputSchema.safeParse({ tags });
  if (!parsed.success) return log.warn('web revalidate skipped', { reason: 'invalid tags' });
  let cfg: ReturnType<typeof env>;
  try {
    cfg = env();
  } catch (e) {
    return log.error('web revalidate failed', { error: e instanceof Error ? e.message : String(e) });
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
      if (res.ok) return log.info('web revalidated', { tags: parsed.data.tags, attempt });
      last = `status ${res.status}`;
      if (res.status < 500) break; // 401/422 will not get better on retry
    } catch (e) {
      last = e instanceof Error ? e.name : String(e);
    }
  }
  log.error('web revalidate failed', { tags: parsed.data.tags, error: last });
}
