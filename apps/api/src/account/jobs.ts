import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { pick } from '../pick';
import { createLogger } from '@remoa/log';
import { dbm } from '../db';
import { deletePrefix } from '../storage/storage';
import type { StripePort } from '../billing/stripe';
import { GRACE_DAYS } from './account';
import { invalidate } from '../cache';
import { personalQuestionPrefix } from '../questions/privacy/export';

const DAY = 86_400_000;
const log = createLogger({ requestId: 'job-account' });

/** F08 FR-7: hard-delete accounts soft-deleted more than 7 days ago. auth.users delete cascades to every user table. */
export async function purgeDeletedAccounts(now: Date, stripe?: StripePort) {
  const { db, profiles, subscriptions } = await dbm();
  const due = await db.select({ id: profiles.userId }).from(profiles)
    .where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, new Date(now.getTime() - GRACE_DAYS * DAY))));
  for (const { id } of due) {
    // Safety net: a delete that skipped the API (or a subscription made later) must not keep charging after the purge.
    const [sub] = await db.select(pick(subscriptions, 'stripeSubscriptionId', 'status')).from(subscriptions).where(eq(subscriptions.userId, id));
    if (sub?.stripeSubscriptionId && sub.status !== 'canceled') {
      try {
        if (!stripe) throw new Error('billing unavailable');
        await stripe.cancelNow(sub.stripeSubscriptionId);
      } catch (e) {
        log.error('account purge skipped: live subscription not canceled', { userId: id, error: String(e) });
        continue;
      }
    }
    // Storage first and best effort: a failure must not block the legal deletion, but is logged for follow-up.
    for (const prefix of [`uploads/${id}/`, `assets/${id}/`, `avatars/${id}/`, `support/${id}/`, personalQuestionPrefix(id)]) {
      await deletePrefix(prefix).catch((e) => log.error('storage purge failed', { userId: id, prefix, error: String(e) }));
    }
    // One failing user (e.g. an FK without cascade) must not stop the others' legal deletion.
    try {
      await db.execute(sql`delete from auth.users where id = ${id}`);
      await invalidate('account.deleted', { userId: id });
      log.info('account purged', { userId: id });
    } catch (e) {
      log.error('account purge failed', { userId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return due.length;
}

/** F08 FR-8: free-text answers are kept 180 days. */
export async function expireAnswerTexts(now: Date) {
  const { db, attempts } = await dbm();
  const cut = new Date(now.getTime() - 180 * DAY);
  const rows = await db.update(attempts).set({ answerText: null }).where(and(isNotNull(attempts.answerText), lt(attempts.createdAt, cut))).returning({ id: attempts.id });
  return rows.length;
}
