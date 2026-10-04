// P-019: per-user cap on POST /v1/uploads/sign.
import { err, type Result } from '@remoa/contracts';

const HOUR = 3_600_000;
export const UPLOAD_SIGN_PER_HOUR = 60;
const hits = new Map<string, number[]>();

/** ponytail: per-process, in memory (same as support/rate-limit.ts); move to the DB/Redis if the API scales out (Q-008). */
export function takeUploadSlot(userId: string, now = Date.now()): Result<null> {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= HOUR)) hits.delete(k);
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= UPLOAD_SIGN_PER_HOUR) { hits.set(userId, recent); return err('rate_limited', 'too many uploads, try again later'); }
  hits.set(userId, [...recent, now]);
  return { ok: true, data: null };
}
