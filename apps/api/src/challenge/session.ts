import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  MAX_SKIPS_PER_ITEM, challengeItemPublicSchema, err, idSchema, ok, rubricSchema, type Answer, type AnswerOutput, type Dispute, type FinishSession,
  type FsrsMemory, type GradeAnswer, type Grade, type Rate, type Result, type Skip, type StartSession,
} from '@remoa/contracts';
import { preview, verdictToGrade } from '@remoa/fsrs';
import type { Tx } from '@remoa/db';
import { Abort, dbm, guard, run } from '../db';
import { recordAttempt } from '../review/record-attempt';
import { buildSession, type Answered, type StoredItem } from './build';
import { assertQuota, refundQuota } from './quota';

export const GRADER_TIMEOUT_MS = 8000;

const fail = (code: Parameters<typeof err>[0], message: string) => new Abort({ code, message });
type SessionRow = { id: string; userId: string; boardId: string | null; startedAt: Date; endedAt: Date | null; items: unknown };

/** Loads and locks the session (`for no key update`: the attempt insert's FK check must not wait on this lock). RLS: other users' sessions do not exist. */
async function locked<T>(userId: string, sessionId: string, fn: (tx: Tx, s: typeof import('@remoa/db'), row: SessionRow, items: StoredItem[]) => Promise<T>): Promise<Result<T>> {
  return guard(() =>
    run(userId, async (tx, s) => {
      if (!idSchema.safeParse(sessionId).success) throw fail('not_found', 'session not found');
      const [row] = await tx.select().from(s.sessions).where(eq(s.sessions.id, sessionId)).for('no key update');
      if (!row) throw fail('not_found', 'session not found');
      return fn(tx, s, row, row.items as StoredItem[]);
    }),
  );
}
const save = (tx: Tx, s: typeof import('@remoa/db'), id: string, items: StoredItem[]) =>
  tx.update(s.sessions).set({ items, updatedAt: new Date() }).where(eq(s.sessions.id, id));
const findItem = (items: StoredItem[], itemId: string) => {
  const i = items.findIndex((x) => x.id === itemId);
  if (i < 0) throw fail('not_found', 'item not found');
  return i;
};
const notEnded = (row: SessionRow) => {
  if (row.endedAt) throw fail('conflict', 'session already finished');
};

/** Deterministic UUID (v5-style) per (session, item): rate retries hit recordAttempt's idempotency. */
export const attemptIdFor = (sessionId: string, itemId: string) => {
  const h = createHash('sha1').update(`remoa-attempt:${sessionId}:${itemId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

// --- start -------------------------------------------------------------------------------------------------------------

export const startSession: StartSession = async (userId, input) => {
  const limit = input.limit ?? 12;
  const items = await buildSession(userId, input.kind, input.boardId, limit, new Date());
  if (!items.ok) return items;
  const sessionId = await run(userId, async (tx, s) => {
    const [r] = await tx.insert(s.sessions).values({ userId, boardId: input.boardId ?? null, kind: input.kind, items: items.data }).returning({ id: s.sessions.id });
    return r!.id;
  });
  return ok({ sessionId, items: items.data.map((i) => challengeItemPublicSchema.parse(i)) });
};

// --- answer ------------------------------------------------------------------------------------------------------------

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error('grader timeout')), ms)))]);
  } finally {
    clearTimeout(t);
  }
};

const medianMs = async (tx: Tx, userId: string, mode: string): Promise<number | null> => {
  const [r] = await tx.execute<{ m: number | null }>(sql`
    select percentile_cont(0.5) within group (order by duration_ms)::float8 as m
    from (select duration_ms from attempts where user_id = ${userId} and mode = ${mode}::challenge_mode and duration_ms is not null order by created_at desc limit 50) t`);
  return r?.m ?? null;
};

const previewOf = async (tx: Tx, s: typeof import('@remoa/db'), userId: string, item: StoredItem) => {
  const [st] = await tx.select().from(s.fsrsState).where(and(eq(s.fsrsState.userId, userId), eq(s.fsrsState.cardId, item.cardId), eq(s.fsrsState.subId, item.subId ?? '')));
  return preview(st && st.reps > 0 ? (st as FsrsMemory) : null, new Date());
};
const outputOf = (item: StoredItem, a: Answered, pv: AnswerOutput['preview']): AnswerOutput => ({
  canonical: item.canonical, verdict: a.verdict, suggestedGrade: a.suggestedGrade, gradeLocked: a.gradeLocked, fallback: a.fallback, preview: pv,
});

export const createAnswer = (grade?: GradeAnswer): Answer => async (userId, input) =>
  locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    if (item.x.answered) return outputOf(item, item.x.answered, await previewOf(tx, s, userId, item)); // idempotent: no regrade, no quota
    notEnded(row);

    const a: Answered = {
      inputKind: input.inputKind, durationMs: input.durationMs, answerText: input.inputKind === 'text' ? input.text : null,
      verdict: null, suggestedGrade: null, gradeLocked: false, fallback: null,
    };
    if (input.inputKind === 'mcq') {
      if (!item.options) throw fail('validation', 'item has no options');
      a.suggestedGrade = item.options[input.optionIndex] === item.canonical ? 'good' : 'again';
    } else if (input.inputKind === 'text' || input.inputKind === 'voice') {
      const [card] = await tx.select({ rubric: s.cards.rubric }).from(s.cards).where(eq(s.cards.id, item.cardId));
      const rubric = rubricSchema.safeParse(card?.rubric);
      if (item.grading === 'none' || !rubric.success) a.fallback = 'no_rubric';
      else if (!grade) a.fallback = 'grader_error'; // no grader wired (prod before F05): do not burn quota
      else if (!(await assertQuota(userId, 'ai_grades')).ok) a.fallback = 'quota';
      else {
        const g = await withTimeout(
          Promise.resolve().then(() => grade({ prompt: item.prompt, canonical: item.canonical, rubric: rubric.data, neighbors: item.x.nb, answer: input.text })),
          GRADER_TIMEOUT_MS,
        ).catch(() => null);
        if (!g || !g.ok) {
          a.fallback = 'grader_error';
          await refundQuota(userId); // no correction delivered, no unit spent
        } else {
          a.verdict = g.data;
          a.gradeLocked = g.data.criticalError;
          a.suggestedGrade = verdictToGrade(g.data, { durationMs: input.durationMs, medianMs: await medianMs(tx, userId, item.mode) });
        }
      }
    }
    items[idx] = { ...item, x: { ...item.x, answered: a } };
    await save(tx, s, row.id, items);
    return outputOf(item, a, await previewOf(tx, s, userId, item));
  });

/** `authenticated` cannot update review_queue: link the dispute to its attempt with the server connection. */
const linkDispute = async (reviewItemId: string, attemptId: string) => {
  const m = await dbm();
  await m.db.update(m.reviewQueue).set({ attemptId }).where(eq(m.reviewQueue.id, reviewItemId));
};

// --- rate --------------------------------------------------------------------------------------------------------------

export const rate: Rate = async (userId, input) =>
  locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    const a = item.x.answered;
    if (!a) throw fail('conflict', 'answer the item before rating it');
    if (item.x.rated) return { due: new Date(item.x.rated.due) }; // idempotent
    notEnded(row);
    if (a.gradeLocked && input.grade !== 'again') throw fail('validation', 'grade is locked at "again" (critical error)');
    const overridden = input.overridden || (a.suggestedGrade !== null && a.suggestedGrade !== input.grade);
    const r = await recordAttempt({
      id: attemptIdFor(row.id, item.id), userId, cardId: item.cardId, subId: item.subId, sessionId: row.id, mode: item.mode, inputKind: a.inputKind,
      answerText: a.answerText, verdict: a.verdict ? { ...a.verdict, disputed: !!item.x.disputed } : null, grade: input.grade, gradeOverridden: overridden,
      durationMs: a.durationMs, createdAt: new Date(),
    });
    if (!r.ok) throw new Abort(r.error);
    if (item.x.reviewItemId) await linkDispute(item.x.reviewItemId, attemptIdFor(row.id, item.id)); // disputed before rating
    items[idx] = { ...item, x: { ...item.x, rated: { grade: input.grade, due: r.data.due.toISOString(), overridden } } };
    await save(tx, s, row.id, items);
    return { due: r.data.due };
  });

// --- dispute -----------------------------------------------------------------------------------------------------------

export const dispute: Dispute = async (userId, input) =>
  locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    if (!item.x.answered?.verdict) throw fail('conflict', 'only graded answers can be disputed');
    if (item.x.reviewItemId) return { reviewItemId: item.x.reviewItemId };
    const reviewItemId = crypto.randomUUID(); // generated here: `authenticated` can insert into review_queue but not read it back
    const attemptId = item.x.rated ? attemptIdFor(row.id, item.id) : null;
    await tx.insert(s.reviewQueue).values({ id: reviewItemId, cardId: item.cardId, status: 'pending', flagSource: 'user_disagree', attemptId });
    if (attemptId) await tx.update(s.attempts).set({ verdict: { ...item.x.answered.verdict, disputed: true } }).where(eq(s.attempts.id, attemptId));
    items[idx] = { ...item, x: { ...item.x, disputed: true, reviewItemId } };
    await save(tx, s, row.id, items);
    return { reviewItemId };
  });

// --- skip --------------------------------------------------------------------------------------------------------------

export const skip: Skip = async (userId, input) =>
  locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    notEnded(row);
    if (item.x.answered) throw fail('conflict', 'item already answered');
    if (item.x.skips >= MAX_SKIPS_PER_ITEM) throw fail('conflict', 'skip limit reached');
    const next = [...items.filter((_, i) => i !== idx), { ...item, x: { ...item.x, skips: item.x.skips + 1 } }];
    await save(tx, s, row.id, next);
    return { remaining: next.filter((i) => !i.x.rated).length };
  });

// --- finish ------------------------------------------------------------------------------------------------------------

export const finishSession: FinishSession = async (userId, sessionId) =>
  locked(userId, sessionId, async (tx, s, row, items) => {
    const endedAt = row.endedAt ?? new Date();
    if (!row.endedAt) await tx.update(s.sessions).set({ endedAt, updatedAt: new Date() }).where(eq(s.sessions.id, row.id));
    const rated = items.filter((i) => i.x.rated);
    const isWrong = (g: Grade) => g === 'again';
    const dues = rated.map((i) => i.x.rated!.due).sort();
    return {
      sessionId: row.id,
      correct: rated.filter((i) => !isWrong(i.x.rated!.grade)).length,
      wrong: rated.filter((i) => isWrong(i.x.rated!.grade)).length,
      toReview: [...new Set(rated.filter((i) => ['again', 'hard'].includes(i.x.rated!.grade)).map((i) => i.cardId))],
      nextDue: dues[0] ? new Date(dues[0]) : null,
      durationMs: endedAt.getTime() - row.startedAt.getTime(),
    };
  });
