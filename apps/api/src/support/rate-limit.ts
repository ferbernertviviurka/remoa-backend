// D-477: per-user hourly caps on attachment signing and student replies (ticket creation has its own DB-backed limit).
import { err, supportErrors, type Result } from '@remoa/contracts';

const HOUR = 3_600_000;
export const SUPPORT_RATE = { sign: 20, reply: 30 } as const;
const hits = new Map<string, number[]>();

/** ponytail: per-process, in memory; move to the DB/Redis if the API scales out (Q-008). */
export function takeSupportSlot(userId: string, kind: keyof typeof SUPPORT_RATE, now = Date.now()): Result<null> {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= HOUR)) hits.delete(k);
  const key = `${userId}|${kind}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= SUPPORT_RATE[kind]) { hits.set(key, recent); return err('rate_limited', supportErrors.rateLimited); }
  hits.set(key, [...recent, now]);
  return { ok: true, data: null };
}
