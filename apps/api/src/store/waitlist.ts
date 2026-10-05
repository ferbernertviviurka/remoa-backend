// G16 / F22 Fase A: store waitlist (CCR-030, D-650–D-659). Upsert by user, delete = opt-out (hard delete, D-653).
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { createLogger } from '@remoa/log';
import { err, ok, storeConfigSchema, storeErrors, storeStatusSchema, storeWaitlistInputSchema, type StoreConfig, type StoreWaitlistEntry, type Result } from '@remoa/contracts';
import { sendEmail } from '../account/mailer';
import { dbm } from '../db';
import { storeWaitlistSubject, storeWaitlistText } from './copy';

/** D-654: status and split % are config (env), never copy. Invalid env falls back to the safe defaults. */
export function getStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const status = storeStatusSchema.safeParse(env.STORE_STATUS);
  const pct = Number(env.STORE_SPLIT_SELLER_PCT ?? 85);
  return storeConfigSchema.parse({ status: status.success ? status.data : 'soon', splitSellerPct: Number.isInteger(pct) && pct >= 1 && pct <= 99 ? pct : 85 });
}

export const STORE_WAITLIST_LIMIT = { max: 10, windowMs: 3_600_000 };
const hits = new Map<string, number[]>();
/** ponytail: per-user, in memory (one API instance, Q-008); move to the DB/Redis if the API scales out. */
export function takeStoreWaitlistSlot(userId: string, now = Date.now()): boolean {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= STORE_WAITLIST_LIMIT.windowMs)) hits.delete(k);
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < STORE_WAITLIST_LIMIT.windowMs);
  if (recent.length >= STORE_WAITLIST_LIMIT.max) return (hits.set(userId, recent), false);
  hits.set(userId, [...recent, now]);
  return true;
}

const toEntry = (r: { email: string; wantsBuy: boolean; wantsSell: boolean; sellerRole: string | null; updatedAt: Date }): StoreWaitlistEntry => ({
  email: r.email,
  interest: [...(r.wantsBuy ? (['buy'] as const) : []), ...(r.wantsSell ? (['sell'] as const) : [])],
  sellerRole: r.sellerRole as StoreWaitlistEntry['sellerRole'],
  updatedAt: r.updatedAt,
});

export async function getStoreWaitlist(userId: string): Promise<Result<StoreWaitlistEntry | null>> {
  const { db, storeWaitlist: t } = await dbm();
  const [r] = await db.select().from(t).where(eq(t.userId, userId));
  return ok(r ? toEntry(r) : null);
}

/** Only `soon` is implemented (FR-14): any other status closes the list. */
export async function putStoreWaitlist(userId: string, input: unknown, requestId: string): Promise<Result<StoreWaitlistEntry>> {
  const p = storeWaitlistInputSchema.safeParse(input);
  if (!p.success) return err('validation', p.error.issues[0]?.message ?? 'invalid body');
  if (getStoreConfig().status !== 'soon') return err('conflict', 'store waitlist is closed');
  if (!takeStoreWaitlistSlot(userId)) return err('rate_limited', storeErrors.rateLimited);
  const { db, storeWaitlist: t } = await dbm();
  const v = p.data;
  const wantsBuy = v.interest.includes('buy');
  const wantsSell = v.interest.includes('sell');
  const [row] = await db.insert(t).values({ userId, email: v.email, wantsBuy, wantsSell, sellerRole: v.sellerRole })
    .onConflictDoUpdate({ target: t.userId, set: { email: v.email, wantsBuy, wantsSell, sellerRole: v.sellerRole, consentedAt: sql`now()`, updatedAt: sql`now()` } })
    .returning({ ...getTableColumns(t), inserted: sql<boolean>`(xmax = 0)` });
  if (!row) return err('internal', 'upsert failed');
  const log = createLogger({ requestId });
  log.info('store_waitlist_saved', { wantsBuy, wantsSell, sellerRole: v.sellerRole, created: row.inserted }); // no e-mail in logs
  if (row.inserted) {
    try {
      await sendEmail({ to: v.email, subject: storeWaitlistSubject, text: storeWaitlistText });
    } catch {
      log.warn('store waitlist confirmation failed'); // signed up anyway; same degradation as the landing waitlist
    }
  }
  return ok(toEntry(row));
}

/** Idempotent: leaving when not on the list is still `ok`. */
export async function leaveStoreWaitlist(userId: string): Promise<Result<null>> {
  const { db, storeWaitlist: t } = await dbm();
  await db.delete(t).where(eq(t.userId, userId));
  return ok(null);
}
