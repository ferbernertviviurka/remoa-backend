/**
 * F34 FR-15/FR-16 (D-1822): answer from the preview drawer, outside a session the student sees. The server corrects through an internal
 * 1-item study session (`config.drawer`, finalized right away, BE-2's answerInDrawer; kept out of history). Idempotent by mutationId.
 * The key, explanation and verdict leave only here, after the attempt is stored.
 */
import { sql } from 'drizzle-orm';
import { questionDrawerAttemptSchema, questionReferenceAfterAnswerSchema, type QuestionDrawerAnswerInput } from '@remoa/contracts';
import { asServer, run } from '../../db';
import { answerInDrawer } from '../sessions/service';
import { answerOutcome } from '../sessions/recalculation';
import { conflict, getQuestionRow, lastAttemptsSQL, missing, obsoleteSuccessor, readable, type Row } from './service';

const object = (v: unknown): Row => (typeof v === 'object' && v !== null ? (v as Row) : {});

export async function drawerAnswer(userId: string, id: string, input: QuestionDrawerAnswerInput) {
  const q = await run(userId, (tx) => getQuestionRow(tx, userId, id));
  if (q.type !== 'objective') throw conflict('discursive_use_challenge');
  if (q.availability !== 'active') throw conflict('question_not_answerable');
  return answerInDrawer(userId, id, input);
}

/** GET /:id/attempt: the caller's latest counted attempt on this question (any version of the canonical), or null. Reference gated by current access. */
export async function drawerLastAttempt(userId: string, id: string) {
  const last = await run(userId, async (tx) => {
    const q = await getQuestionRow(tx, userId, id, false);
    const [a] = await asServer<Row>(tx, sql`SELECT * FROM (${lastAttemptsSQL(userId, [String(q.canonical_id)], true)}) l`);
    if (!a || a.selected_key == null) return null;
    const [current] = await asServer<Row>(tx, sql`SELECT q.availability,${obsoleteSuccessor} obsolete FROM question_bank q WHERE q.id=${a.question_id} AND ${readable(userId, true)}`);
    if (!current) throw missing();
    const saved = object(a.reference_snapshot);
    const reference = questionReferenceAfterAnswerSchema.parse({ ...saved, annulled: saved.annulled === true || current.availability === 'annulled', obsolete: saved.obsolete === true || current.obsolete === true });
    const result = answerOutcome(true, String(a.selected_key), reference.correctKey, reference.annulled);
    return { questionId: String(a.question_id), selectedKey: a.selected_key, result, answeredAt: a.submitted_at, reference };
  });
  return { last: last ? questionDrawerAttemptSchema.parse(last) : null };
}
