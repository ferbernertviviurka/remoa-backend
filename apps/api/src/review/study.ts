import { and, eq, isNull, sql } from 'drizzle-orm';
import { cardStudyActionSchema, idSchema, parseWith, type CardStudyAction, type CardStudyState, type Result } from '@remoa/contracts';
import { Abort, guard, run } from '../db';
import { invalidate } from '../cache';

/** F03 FR-9 (D-522): owner-only; anyone else (or a missing/deleted card) gets 404. suspend/unsuspend keep FSRS state; reset drops it (every sub_id), keeps attempts. */
export async function setCardStudy(userId: string, cardId: string, action: CardStudyAction): Promise<Result<CardStudyState>> {
  const a = parseWith(cardStudyActionSchema, action);
  if (!a.ok) return a;
  const notFound = () => new Abort({ code: 'not_found', message: 'card not found' });
  if (!idSchema.safeParse(cardId).success) return guard(async () => { throw notFound(); });
  const r = await guard(() =>
    run(userId, async (tx, s) => {
      const [row] = await tx
        .select({ suspendedAt: s.cards.suspendedAt })
        .from(s.cards)
        .innerJoin(s.boards, eq(s.boards.id, s.cards.boardId))
        .where(and(eq(s.cards.id, cardId), isNull(s.cards.deletedAt), eq(s.boards.userId, userId)))
        .for('update', { of: s.cards });
      if (!row) throw notFound();
      if (a.data === 'reset') {
        await tx.delete(s.fsrsState).where(and(eq(s.fsrsState.userId, userId), eq(s.fsrsState.cardId, cardId)));
        return { cardId, suspendedAt: row.suspendedAt };
      }
      if (a.data === 'suspend' && row.suspendedAt) return { cardId, suspendedAt: row.suspendedAt }; // idempotent: keep the original timestamp
      const [u] = await tx.update(s.cards).set({ suspendedAt: a.data === 'suspend' ? sql`now()` : null }).where(eq(s.cards.id, cardId)).returning({ suspendedAt: s.cards.suspendedAt });
      return { cardId, suspendedAt: u!.suspendedAt };
    }),
  );
  if (r.ok) await invalidate('card.changed', { userId });
  return r;
}
