// G18 F24: signed webhooks (Standard Webhooks = what Svix signs the Resend webhooks with, and what Supabase signs the Send Email hook with).
// Same library the Resend SDK uses for `webhooks.verify` (standardwebhooks): HMAC-SHA256 over `id.timestamp.body`, 5-minute tolerance.
import { Webhook } from 'standardwebhooks';

export type SignedHeaders = { id: string | undefined; timestamp: string | undefined; signature: string | undefined };

/**
 * `secret`: `whsec_<base64>` (Resend) or `v1,whsec_<base64>` (Supabase). `body` must be the raw request text (any re-serialization breaks the MAC).
 * Returns the parsed JSON, or null when the secret is missing, the signature is wrong or the timestamp is outside the tolerance.
 */
export function verifySigned(secret: string | undefined, h: SignedHeaders, body: string): unknown {
  if (!secret || !h.id || !h.timestamp || !h.signature) return null;
  try {
    return new Webhook(secret.replace(/^v1,/, '')).verify(body, { 'webhook-id': h.id, 'webhook-timestamp': h.timestamp, 'webhook-signature': h.signature });
  } catch {
    return null;
  }
}

/** Test helper: the headers a provider would send for `body` at `at`. */
export function signForTest(secret: string, id: string, at: Date, body: string): SignedHeaders {
  return { id, timestamp: String(Math.floor(at.getTime() / 1000)), signature: new Webhook(secret.replace(/^v1,/, '')).sign(id, at, body) };
}
