// Test seam for e-mail: collects what would reach the provider (emails/send.ts hooks) instead of writing to .emails/.
import { randomUUID } from 'node:crypto';
import { setEmailTestHooks, type OutgoingEmail } from './emails/send';

/** Installs a fake provider and returns the live list of sent messages. Call once per test file (beforeAll). */
export function captureEmails(): OutgoingEmail[] {
  const sent: OutgoingEmail[] = [];
  setEmailTestHooks({ transport: async (m) => (sent.push(m), { id: `test-${randomUUID()}` }), sleep: async () => undefined });
  return sent;
}

/** deliverEmail returns after the provider call; notifyAddress/notify are awaited, but fire-and-forget callers (referral invites) need a tick. */
export const settle = () => new Promise((r) => setTimeout(r, 150));

/** The template an outgoing message was rendered from (sendEmail tags every message). */
export const templateOf = (m: OutgoingEmail) => m.tags?.find((t) => t.name === 'template')?.value;
