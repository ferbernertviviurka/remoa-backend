import { and, eq, isNull } from 'drizzle-orm';
import { ok, type FsrsMemory, type FsrsState, type RecordAttempt } from '@remoa/contracts';
import { grades } from '@remoa/contracts';
import { schedule } from '@remoa/fsrs';
import { Abort, guard, run } from '../db';
import { invalidateRetrievability } from './queue';

const bad = (message: string) => new Abort({ code: 'validation', message });
const payloadIds = (payload: unknown, key: 'steps' | 'masks') => {
  const list = (payload as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list.map((x) => (x as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string') : [];
};

/** F04 calls this after the grade is settled; there is no public endpoint. Idempotent by `attempt.id`, serialised per (user, card, sub). */
export const recordAttempt: RecordAttempt = async (a) => {
  const r = await guard(() =>
    run(a.userId, async (tx, s) => {
      const [card] = await tx
        .select({ type: s.cards.type, payload: s.cards.payload })
        .from(s.cards)
        .where(and(eq(s.cards.id, a.cardId), isNull(s.cards.deletedAt))); // RLS: readable boards only
      if (!card) throw new Abort({ code: 'not_found', message: 'card not found' });
      if (card.type === 'note') throw bad('note cards are not reviewable');
      const subId = a.subId ?? '';
      const valid = card.type === 'flow' ? payloadIds(card.payload, 'steps') : card.type === 'image' ? payloadIds(card.payload, 'masks') : null;
      if (valid ? !valid.includes(subId) : subId !== '') throw bad('subId does not belong to the card');

      // The row lock serialises concurrent attempts on the same item, so no update is lost.
      await tx.insert(s.fsrsState).values({ userId: a.userId, cardId: a.cardId, subId, due: a.createdAt, createdAt: a.createdAt }).onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(s.fsrsState)
        .where(and(eq(s.fsrsState.userId, a.userId), eq(s.fsrsState.cardId, a.cardId), eq(s.fsrsState.subId, subId)))
        .for('update');
      const prev: FsrsMemory | null = row!.reps === 0 ? null : row!;
      const toState = (m: FsrsMemory): FsrsState => ({ ...m, userId: a.userId, cardId: a.cardId, subId: a.subId });

      // Checked after the lock: a concurrent duplicate waits here and sees the committed attempt.
      const [seen] = await tx.select({ id: s.attempts.id }).from(s.attempts).where(eq(s.attempts.id, a.id));
      if (seen) return toState(row!);

      // an out-of-order attempt must not produce a negative elapsed time
      const now = prev?.lastReview && a.createdAt < prev.lastReview ? prev.lastReview : a.createdAt;
      const next = schedule(prev, a.grade, now);
      await tx.update(s.fsrsState).set(next)
        .where(and(eq(s.fsrsState.userId, a.userId), eq(s.fsrsState.cardId, a.cardId), eq(s.fsrsState.subId, subId)));
      await tx.insert(s.attempts).values({
        id: a.id, userId: a.userId, cardId: a.cardId, subId, sessionId: a.sessionId, mode: a.mode, inputKind: a.inputKind,
        answerText: a.answerText, verdict: a.verdict, grade: grades.indexOf(a.grade) + 1, gradeOverridden: a.gradeOverridden,
        durationMs: a.durationMs, createdAt: a.createdAt,
      });
      return toState(next);
    }),
  );
  if (!r.ok) return r;
  invalidateRetrievability(a.userId);
  return ok({ state: r.data, due: r.data.due });
};
