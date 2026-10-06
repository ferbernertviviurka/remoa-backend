import { and, eq, isNull, sql } from 'drizzle-orm';
import { pick } from '../pick';
import type { Tx } from '@remoa/db';
import { ok, type FsrsMemory, type FsrsState, type RecordAttempt } from '@remoa/contracts';
import { grades } from '@remoa/contracts';
import { schedule } from '@remoa/fsrs';
import { Abort, guard, run } from '../db';
import { invalidate } from '../cache';

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
        .select(pick(s.fsrsState, 'stability', 'difficulty', 'due', 'reps', 'lapses', 'lastReview', 'state', 'learningSteps', 'scheduledDays'))
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
  await invalidate('review.answered', { userId: a.userId });
  return ok({ state: r.data, due: r.data.due });
};

type Attempt = Parameters<RecordAttempt>[0];
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * G21 FR-22 (D-1035): the answer path of `POST /v1/challenge/rate` in the caller's transaction and in TWO statements (was 7 queries
 * in a second, nested transaction on another connection). `trusted`: the item came from the session's own build (card and sub id were
 * validated then), so the card checks of `recordAttempt` are not repeated; a card deleted since then still is `not_found` (the lock
 * statement selects it).
 *   1. lock: `insert ... select from cards ... on conflict do update` (no-op write) takes the `fsrs_state` row lock and returns it;
 *   2. one CTE: `insert attempts on conflict do nothing` + `update fsrs_state ... where exists(attempt inserted)` + the caller's
 *      `update sessions` (`persist`), so a retry never schedules twice and nothing is left half-written.
 */
export async function rateInTx(
  tx: Tx, a: Attempt, persist: (due: Date) => { sessionId: string; items: unknown },
): Promise<{ state: FsrsState; due: Date }> {
  const sub = a.subId ?? '';
  const [row] = await tx.execute<{ stability: number; difficulty: number; due: string; reps: number; lapses: number; last_review: string | null; state: FsrsMemory['state']; learning_steps: number; scheduled_days: number }>(sql`
    insert into fsrs_state (user_id, card_id, sub_id, due, created_at)
    select ${a.userId}, c.id, ${sub}, ${iso(a.createdAt)}::timestamptz, ${iso(a.createdAt)}::timestamptz
    from cards c where c.id = ${a.cardId} and c.deleted_at is null and c.type <> 'note'
    on conflict (user_id, card_id, sub_id) do update set user_id = excluded.user_id
    returning stability, difficulty, due, reps, lapses, last_review, state, learning_steps, scheduled_days`);
  if (!row) throw new Abort({ code: 'not_found', message: 'card not found' });
  const cur: FsrsMemory = {
    stability: row.stability, difficulty: row.difficulty, due: new Date(row.due), reps: row.reps, lapses: row.lapses,
    lastReview: row.last_review ? new Date(row.last_review) : null, state: row.state, learningSteps: row.learning_steps, scheduledDays: row.scheduled_days,
  };
  const prev = cur.reps === 0 ? null : cur;
  const now = prev?.lastReview && a.createdAt < prev.lastReview ? prev.lastReview : a.createdAt; // out-of-order: no negative elapsed
  const next = schedule(prev, a.grade, now);
  const { sessionId, items } = persist(next.due);
  const verdict = a.verdict === null || a.verdict === undefined ? null : JSON.stringify(a.verdict);
  await tx.execute(sql`
    with a as (
      insert into attempts (id, user_id, card_id, sub_id, session_id, mode, input_kind, answer_text, verdict, grade, grade_overridden, duration_ms, created_at)
      values (${a.id}, ${a.userId}, ${a.cardId}, ${sub}, ${a.sessionId}, ${a.mode}::challenge_mode, ${a.inputKind}::input_kind, ${a.answerText}, ${verdict}::jsonb,
        ${grades.indexOf(a.grade) + 1}, ${a.gradeOverridden}, ${a.durationMs}, ${iso(a.createdAt)}::timestamptz)
      on conflict (id) do nothing returning id
    ), f as (
      update fsrs_state set stability = ${next.stability}, difficulty = ${next.difficulty}, due = ${iso(next.due)}::timestamptz, reps = ${next.reps}, lapses = ${next.lapses},
        last_review = ${iso(next.lastReview)}::timestamptz, state = ${next.state}::fsrs_card_state, learning_steps = ${next.learningSteps}, scheduled_days = ${next.scheduledDays}, updated_at = now()
      where user_id = ${a.userId} and card_id = ${a.cardId} and sub_id = ${sub} and exists (select 1 from a) returning 1
    )
    update sessions set items = ${JSON.stringify(items)}::jsonb, updated_at = now() where id = ${sessionId}`);
  return { state: { ...next, userId: a.userId, cardId: a.cardId, subId: a.subId }, due: next.due };
}
