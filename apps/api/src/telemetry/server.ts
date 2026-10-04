import { eventSchemas, type EventName, type EventProps } from '@remoa/contracts';
import { createLogger } from '@remoa/log';

const log = createLogger({ requestId: 'telemetry' });

/**
 * F11 server events (P-054, P-184, P-207) to the Mixpanel HTTP API. `distinctId` is the user id, never e-mail or name.
 * Props are validated by the contract schema (strict: counts and enums only). Never throws, never blocks the caller's result:
 * call it after the transaction commits. No MIXPANEL_TOKEN = no-op with a debug log.
 */
export async function trackServer<E extends EventName>(event: E, props: EventProps[E], distinctId: string, extra: { plan?: string } = {}): Promise<void> {
  const token = process.env.MIXPANEL_TOKEN;
  const parsed = eventSchemas[event].safeParse(props);
  if (!parsed.success) return log.warn('server event dropped: invalid props', { event });
  if (!token) return log.info('server event skipped: MIXPANEL_TOKEN unset', { event });
  try {
    const res = await fetch('https://api.mixpanel.com/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ event, properties: { ...parsed.data, ...extra, token, distinct_id: distinctId, time: Date.now(), platform: 'server', $insert_id: crypto.randomUUID() } }]),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) log.warn('server event failed', { event, status: res.status });
  } catch (e) {
    log.warn('server event failed', { event, error: String(e) });
  }
}
