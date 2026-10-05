// F16 FR-14 / F12 FR-2: public waitlist. Never reveals whether an e-mail already exists.
import { z } from 'zod';
import { createLogger } from '@remoa/log';
import { ok, parseWith, waitlistEntrySchema, type Result } from '@remoa/contracts';
import { dbm } from '../db';
import { notifyAddress } from '../notifications/notify';
import { emailHash } from '../referral/email-normalize';

export const waitlistBodySchema = waitlistEntrySchema.extend({ website: z.string().optional() }); // honeypot

export const WAITLIST_LIMIT = { max: 5, windowMs: 3_600_000 };
const hits = new Map<string, number[]>();
/** ponytail: in-memory limiter until Redis/edge (one API instance, Q-008). */
export function takeWaitlistSlot(ip: string, now = Date.now()): boolean {
  for (const [k, v] of hits) if (v.every((t) => now - t >= WAITLIST_LIMIT.windowMs)) hits.delete(k);
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WAITLIST_LIMIT.windowMs);
  if (list.length >= WAITLIST_LIMIT.max) return (hits.set(ip, list), false);
  list.push(now);
  hits.set(ip, list);
  return true;
}

/** Honeypot filled or duplicate e-mail: same `ok` as a real signup, nothing stored/sent. */
export async function joinWaitlist(input: unknown, requestId: string): Promise<Result<null>> {
  const p = parseWith(waitlistBodySchema, input);
  if (!p.ok) return p;
  const { website, email, segment, variant, origin } = p.data;
  if (website) return ok(null);
  const { db, waitlist } = await dbm();
  const rows = await db.insert(waitlist).values({ email: email.toLowerCase(), segment, variant, source: origin }).onConflictDoNothing().returning({ id: waitlist.id });
  if (!rows.length) return ok(null);
  createLogger({ requestId }).info('waitlist_joined', { segment, variant });
  await notifyAddress(email, 'landing_waitlist', { reference: emailHash(email), email: {} }); // never throws; signed up anyway
  return ok(null);
}
