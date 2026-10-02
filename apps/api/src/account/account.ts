import { eq, inArray } from 'drizzle-orm';
import { err, ok, type DeleteAccount, type ExportAccount } from '@remoa/contracts';
import type { StripePort } from '../billing/stripe';
import { run } from '../db';

const DAY = 86_400_000;
export const GRACE_DAYS = 7;

/** One primary-key lookup per request (profiles.user_id). */
export const isAccountDeleted = (userId: string) =>
  run(userId, async (tx, s) => {
    const [p] = await tx.select({ d: s.profiles.deletedAt }).from(s.profiles).where(eq(s.profiles.userId, userId));
    return !!p?.d;
  });

/** F08 FR-7: only the user's own rows; explicit userId filters on top of RLS (boards are readable for approved seeds). */
export const exportAccount: ExportAccount = async (userId) =>
  ok(
    await run(userId, async (tx, s) => {
      const mine = tx.select({ id: s.boards.id }).from(s.boards).where(eq(s.boards.userId, userId));
      const [profile] = await tx.select().from(s.profiles).where(eq(s.profiles.userId, userId));
      return {
        version: 1 as const,
        exportedAt: new Date(),
        userId,
        profile: profile ?? null,
        // F17: the share token and password hash are credentials, not exported data
        boards: (await tx.select().from(s.boards).where(eq(s.boards.userId, userId))).map((b) => ({ ...b, shareToken: null, sharePasswordHash: null })),
        cards: await tx.select().from(s.cards).where(inArray(s.cards.boardId, mine)),
        edges: await tx.select().from(s.edges).where(inArray(s.edges.boardId, mine)),
        attempts: await tx.select().from(s.attempts).where(eq(s.attempts.userId, userId)),
      };
    }),
  );

/** Soft delete; `account/jobs.ts` purges after the grace period. Server-owned write, so superuser connection, not RLS. */
export const deleteAccount = async (userId: string, stripe?: StripePort): ReturnType<DeleteAccount> => {
  const { db, profiles, subscriptions } = await import('@remoa/db');
  // Cancel first: if Stripe fails the account stays live and the user can retry, instead of a deleted account still being charged.
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (sub?.stripeSubscriptionId && sub.status !== 'canceled') {
    if (!stripe) return err('internal', 'billing unavailable');
    try {
      await stripe.cancelNow(sub.stripeSubscriptionId);
    } catch {
      return err('internal', 'subscription cancel failed');
    }
  }
  const now = new Date();
  await db.insert(profiles).values({ userId, deletedAt: now }).onConflictDoUpdate({ target: profiles.userId, set: { deletedAt: now } });
  return ok({ hardDeleteAt: new Date(now.getTime() + GRACE_DAYS * DAY) });
};
