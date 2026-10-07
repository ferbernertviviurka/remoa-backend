import { createHash } from 'node:crypto';
import { pick } from '../pick';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  CHALLENGE_MIN_CARDS, MAX_SKIPS_PER_ITEM, challengeErrors, challengeItemPublicSchema, challengeOptionsSchema, err, unavailableChallengeOption, idSchema, ok, rubricSchema, type Answer, type AnswerInput, type AnswerOutput, type Dispute, type FinishSession,
  type FsrsMemory, type GradeAnswer, type Grade, type GraderInput, type GraderVerdict, type Rate, type Result, type Skip, type StartSession,
} from '@remoa/contracts';
import { preview, verdictToGrade } from '@remoa/fsrs';
import type { Tx } from '@remoa/db';
import { allowGrade } from '../ai/service';
import { Abort, dbm, final, guard, onWire, run, sessionChecked } from '../db';
import { lockStateSql, rateInTx, type LockRow } from '../review/record-attempt';
import { buildSession, type Answered, type Internal, type StoredItem } from './build';
import { reserveAi } from './quota';
import type { Reservation } from '../billing/quota';
import { invalidate } from '../cache';

export const GRADER_TIMEOUT_MS = 8000;

/** G22 (D-1411/D-1413): only a model verdict keeps the ai_grades unit; a local-grader fallback is shown (marked) and the unit goes back. */
async function keepIfAi(verdict: GraderVerdict, held: Reservation, tx?: Tx): Promise<GraderVerdict> {
  if (!verdict.ai) return verdict; // a grader port without AI status (tests, GRADER=mock) counts as a model answer
  const quota = verdict.ai.status === 'ok' ? held.quota : await held.refund(tx);
  return { ...verdict, ai: { ...verdict.ai, quota } };
}

// G22 qa (P-618) + D-1104 (P-532): the ai_grades unit is taken INSIDE the claim's run() (`reserveAi(..., tx)`): no second pool
// connection while the session lock is held, and a rollback of the claim gives it back by itself. Once claimed, the unit outlives that
// transaction and `settle` gives it back on the server connection, outside any lock (P-543, D-1444).

const fail = (code: Parameters<typeof err>[0], message: string) => new Abort({ code, message });
type SessionRow = { id: string; userId: string; boardId: string | null; startedAt: Date; endedAt: Date | null; items: unknown; options?: unknown };
const selfGraded = (row: SessionRow) => challengeOptionsSchema.parse(row.options ?? {}).gradingMode === 'self';

/** Loads and locks the session (`for no key update`: the attempt insert's FK check must not wait on this lock). RLS: other users' sessions do not exist. */
async function locked<T, U = undefined>(
  userId: string, sessionId: string, fn: (tx: Tx, s: typeof import('@remoa/db'), row: SessionRow, items: StoredItem[], alongside: Promise<U>) => Promise<T>,
  alongside?: (tx: Tx) => PromiseLike<U>,
): Promise<Result<T>> {
  return guard(() =>
    run(userId, async (tx, s) => {
      if (!idSchema.safeParse(sessionId).success) throw fail('not_found', 'session not found');
      const rowP = Promise.resolve(tx.select(pick(s.sessions, 'id', 'userId', 'boardId', 'startedAt', 'endedAt', 'items', 'options')).from(s.sessions).where(eq(s.sessions.id, sessionId)).for('no key update'));
      rowP.catch(() => undefined);
      // D-1094: `alongside` leaves in the same flight, right behind the session lock (lock order: sessions, then what it touches)
      if (alongside) await onWire();
      const extra = alongside ? Promise.resolve(alongside(tx)) : Promise.resolve(undefined as U);
      extra.catch(() => undefined);
      const [row] = await rowP;
      if (!row) throw fail('not_found', 'session not found');
      await sessionChecked(); // FUSED_WRITES (D-1093): answer may call the AI grader (an outside service) next
      return fn(tx, s, row, row.items as StoredItem[], extra);
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

/**
 * G21 D-1094: one transaction, 3 round trips (was 3 transactions, 32 with the API ~124 ms away): (1) BEGIN + claims + queue + budget
 * (+ the board's card count), (2) the item context, (3) the insert with its COMMIT. Fused session check (FUSED_WRITES): nothing outside
 * this transaction happens before it settles.
 */
export const startSession: StartSession = async (userId, input) => {
  const limit = input.limit ?? 12;
  const opts = challengeOptionsSchema.safeParse(input.options ?? {});
  if (!opts.success) return err('validation', 'options: invalid');
  const unavailable = unavailableChallengeOption(opts.data); // CCR-019: ai grading and voice are "Em breve"
  if (unavailable) return err('validation', unavailable);
  return run(userId, async (tx, s) => {
    const [items, drawable] = await Promise.all([
      buildSession(tx, userId, input.kind, input.boardId, limit, new Date(), opts.data.order, input.filter, input.studyOrder),
      // D-575: the cards a challenge can draw from (live, not a note, not suspended); same flight as the queue
      input.kind === 'board' && idSchema.safeParse(input.boardId).success
        ? tx.select({ n: count() }).from(s.cards).where(and(eq(s.cards.boardId, input.boardId!), isNull(s.cards.deletedAt), isNull(s.cards.suspendedAt), ne(s.cards.type, 'note')))
        : undefined,
    ]);
    if (!items.ok) return items; // unknown/foreign board: 404 before the count
    if (drawable && drawable[0]!.n < CHALLENGE_MIN_CARDS) return err('validation', challengeErrors.minCards);
    const [r] = await final(tx.insert(s.sessions).values({ userId, boardId: input.boardId ?? null, kind: input.kind, items: items.data, options: opts.data }).returning({ id: s.sessions.id }));
    return ok({ sessionId: r!.id, items: items.data.map((i) => challengeItemPublicSchema.parse(i)), options: opts.data });
  });
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
  const [st] = await tx.select(pick(s.fsrsState, 'reps', 'stability', 'difficulty', 'due', 'lapses', 'lastReview', 'state', 'learningSteps', 'scheduledDays')).from(s.fsrsState).where(and(eq(s.fsrsState.userId, userId), eq(s.fsrsState.cardId, item.cardId), eq(s.fsrsState.subId, item.subId ?? '')));
  return preview(st && st.reps > 0 ? (st as FsrsMemory) : null, new Date());
};
const outputOf = (item: StoredItem, a: Answered, pv: AnswerOutput['preview']): AnswerOutput => ({
  canonical: item.canonical, verdict: a.verdict, suggestedGrade: a.suggestedGrade, gradeLocked: a.gradeLocked, fallback: a.fallback, preview: pv,
});

/** Writes the answer and COMMITs in one flight with the preview read (D-1092); clears a grading claim. Last statement of a run() body. */
const answerNow = async (tx: Tx, s: typeof import('@remoa/db'), row: SessionRow, items: StoredItem[], idx: number, a: Answered) => {
  const item = items[idx]!;
  items[idx] = { ...item, x: { ...item.x, grading: undefined, answered: a } };
  const pv = previewOf(tx, s, row.userId, item);
  await Promise.all([pv, final(save(tx, s, row.id, items))]);
  return outputOf(item, a, await pv);
};

/**
 * P-543 (D-1444): a claim older than this is abandoned (process died, commit failed) and may be taken over; the late commit of the old
 * claim then finds another claim id and discards its verdict (its unit goes back).
 */
const CLAIM_STALE_MS = 2 * GRADER_TIMEOUT_MS;
const claimLive = (g: Internal['grading']) => typeof g === 'object' && Date.now() - Date.parse(g.at) < CLAIM_STALE_MS;

export const createAnswer = (grade?: GradeAnswer): Answer => async (userId, input) => {
  if (input.inputKind === 'text' || input.inputKind === 'voice') {
    // P-543 (D-1444): claim (short transaction) -> grader with no transaction or lock held -> commit (short transaction, optimistic)
    const claim = await claimSpoken(userId, input, !!grade);
    if (!claim.ok) return claim;
    if (claim.data.type === 'done') return ok(claim.data.output);
    const live = claim.data;
    const g = await withTimeout(Promise.resolve().then(() => grade!(live.input)), GRADER_TIMEOUT_MS).catch(() => null);
    return settle(userId, input, g?.ok ? g.data : null, live);
  }
  return locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    if (item.x.answered) return outputOf(item, item.x.answered, await previewOf(tx, s, userId, item)); // idempotent
    if (claimLive(item.x.grading)) throw fail('conflict', 'grade in progress');
    notEnded(row);
    const a: Answered = { inputKind: input.inputKind, durationMs: input.durationMs, answerText: null, verdict: null, suggestedGrade: null, gradeLocked: false, fallback: null };
    if (input.inputKind === 'mcq') {
      if (!item.options) throw fail('validation', 'item has no options');
      a.suggestedGrade = item.options[input.optionIndex] === item.canonical ? 'good' : 'again';
    }
    return answerNow(tx, s, row, items, idx, a);
  });
};

// --- streamed answer (F05: feedback reaches the student while the model writes) -------------------------------------

export type GradeStreamEvent = { feedback?: string; verdict?: GraderVerdict; meta?: { promptVersion: string; tokensIn: number; tokensOut: number; latencyMs: number } };
export type GradeStream = (input: GraderInput) => AsyncIterable<GradeStreamEvent>;
export type AnswerStreamEvent = { feedback: string } | { result: AnswerOutput } | { error: { code: string; message: string } };

type Spoken = Extract<AnswerInput, { inputKind: 'text' | 'voice' }>;
type Live = { type: 'live'; input: GraderInput; held: Reservation; claimId: string };
type Claim = { type: 'done'; output: AnswerOutput } | Live;

async function* limitStream(source: AsyncIterable<GradeStreamEvent>, ms: number): AsyncGenerator<GradeStreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('grader timeout')), ms);
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
    await iterator.return?.();
  }
}

/**
 * Text/voice, first short transaction: either answers right away (stored answer, self-graded, no rubric, no grader, quota, rate limit)
 * or takes the ai_grades unit and a claim on the item (`x.grading`) and COMMITs. The model is called after, with nothing held.
 */
async function claimSpoken(userId: string, input: Spoken, hasGrader: boolean): Promise<Result<Claim>> {
  return locked(userId, input.sessionId, async (tx, s, row, items) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    if (item.x.answered) return { type: 'done' as const, output: outputOf(item, item.x.answered, await previewOf(tx, s, userId, item)) }; // idempotent: no regrade, no quota
    if (claimLive(item.x.grading)) throw fail('conflict', 'grade in progress');
    notEnded(row);
    const a: Answered = { inputKind: input.inputKind, durationMs: input.durationMs, answerText: input.text, verdict: null, suggestedGrade: null, gradeLocked: false, fallback: null };
    const done = async (fallback: Answered['fallback'] = null) => ({ type: 'done' as const, output: await answerNow(tx, s, row, items, idx, { ...a, fallback }) });
    if (selfGraded(row)) return done(); // D-577: text is kept (D-123) but never graded or charged
    // F17 (D-1516): the board's area rides on the same query; an OUTRO map is graded without the medical persona
    const [card] = await tx.select({ rubric: s.cards.rubric, area: s.boards.area }).from(s.cards).innerJoin(s.boards, eq(s.boards.id, s.cards.boardId)).where(eq(s.cards.id, item.cardId));
    const rubric = rubricSchema.safeParse(card?.rubric);
    if (item.grading === 'none' || !rubric.success) return done('no_rubric');
    if (!hasGrader) return done('grader_error'); // no grader wired (prod before F05): do not burn quota
    const held = await reserveAi(userId, 'ai_grades', undefined, tx);
    if (!held.ok) return done('quota');
    if (!allowGrade(userId)) {
      await held.refund(tx);
      return done('grader_error');
    }
    const claimId = crypto.randomUUID();
    items[idx] = { ...item, x: { ...item.x, grading: { id: claimId, at: new Date().toISOString() } } };
    await final(save(tx, s, row.id, items)); // a rollback here gives the unit back by itself (D-1104)
    return { type: 'live' as const, held, claimId, input: { prompt: item.prompt, canonical: item.canonical, rubric: rubric.data, neighbors: item.x.nb, answer: input.text, ...(card?.area === 'OUTRO' && { generic: true }) } };
  });
}

/**
 * Second short transaction: writes the verdict only if the claim is still ours and the item unanswered (optimistic check); otherwise the
 * verdict is dropped and the stored answer returned. The unit claimSpoken committed goes back (server connection, outside the lock,
 * once) when no model verdict is delivered: grader error/timeout, local fallback (D-1411), claim lost, session ended, write failed.
 */
async function settle(userId: string, input: Spoken, verdict: GraderVerdict | null, live: Live): Promise<Result<AnswerOutput>> {
  const { held, claimId } = live;
  if (!verdict || (verdict.ai && verdict.ai.status !== 'ok')) await held.refund(); // before the lock (D-1104, P-532)
  let lost = false;
  try {
    const saved = await locked(userId, input.sessionId, async (tx, s, row, items) => {
      const idx = findItem(items, input.itemId);
      const item = items[idx]!;
      const g = item.x.grading;
      if (item.x.answered || typeof g !== 'object' || g.id !== claimId) {
        lost = true;
        if (item.x.answered) return outputOf(item, item.x.answered, await previewOf(tx, s, userId, item));
        throw fail('conflict', 'grade in progress');
      }
      notEnded(row);
      const a: Answered = { inputKind: input.inputKind, durationMs: input.durationMs, answerText: input.text, verdict: null, suggestedGrade: null, gradeLocked: false, fallback: null };
      if (!verdict) a.fallback = 'grader_error';
      else {
        a.verdict = await keepIfAi(verdict, held); // already refunded above when not a model answer: no query here
        a.gradeLocked = verdict.criticalError;
        a.suggestedGrade = verdictToGrade(verdict, { durationMs: input.durationMs, medianMs: await medianMs(tx, userId, item.mode) });
      }
      return answerNow(tx, s, row, items, idx, a);
    });
    if (lost || !saved.ok) await held.refund(); // G22 qa (P-616): nothing of ours saved = no correction delivered
    return saved;
  } catch (e) {
    await held.refund().catch(() => undefined); // P-618: the write failed (rolled back)
    throw e;
  }
}

/** Text and voice: feedback events, then one result. Anything else is the same JSON answer, as a single event. */
export const createAnswerStream = (grade?: GradeAnswer, stream?: GradeStream) =>
  async function* (userId: string, input: AnswerInput): AsyncGenerator<AnswerStreamEvent> {
    if (!stream || (input.inputKind !== 'text' && input.inputKind !== 'voice')) {
      const r = await createAnswer(grade)(userId, input);
      yield r.ok ? { result: r.data } : { error: r.error };
      return;
    }
    const claim = await claimSpoken(userId, input, true);
    if (!claim.ok) {
      yield { error: claim.error };
      return;
    }
    if (claim.data.type === 'done') {
      yield { result: claim.data.output };
      return;
    }
    const live = claim.data;
    let verdict: GraderVerdict | null = null;
    let settled = false;
    try {
      try {
        for await (const event of limitStream(stream(live.input), GRADER_TIMEOUT_MS)) {
          if (event.feedback) yield { feedback: event.feedback };
          if (event.verdict) verdict = event.verdict;
        }
      } catch {
        /* keep a verdict that already arrived; otherwise settle refunds */
      }
      settled = true;
      const saved = await settle(userId, input, verdict, live);
      yield saved.ok ? { result: saved.data } : { error: saved.error };
    } finally {
      if (!settled) await settle(userId, input, verdict, live).catch(() => undefined); // client left mid-stream
    }
  };


/** `authenticated` cannot update review_queue: link the dispute to its attempt with the server connection. */
const linkDispute = async (reviewItemId: string, attemptId: string) => {
  const m = await dbm();
  await m.db.update(m.reviewQueue).set({ attemptId }).where(eq(m.reviewQueue.id, reviewItemId));
};

// --- rate --------------------------------------------------------------------------------------------------------------

/**
 * G21 FR-22 (D-1035): one transaction, one connection: the session lock, the FSRS lock + read, and one CTE that writes the attempt,
 * the card state and the session (`rateInTx`). The old path nested a second transaction (`recordAttempt`) on another connection
 * while the first held `for no key update` on the session. The dispute link needs the committed attempt (FK) and a server
 * connection, so it runs after the commit.
 */
export const rate: Rate = async (userId, input) => {
  const link: { reviewItemId?: string; attemptId?: string } = {};
  const createdAt = new Date();
  const r = await locked<{ due: Date; fresh: boolean }, LockRow[]>(userId, input.sessionId, async (tx, _s, row, items, lockedRow) => {
    const idx = findItem(items, input.itemId);
    const item = items[idx]!;
    const a = item.x.answered;
    if (!a) throw fail('conflict', 'answer the item before rating it');
    if (item.x.rated) return { due: new Date(item.x.rated.due), fresh: false }; // idempotent
    notEnded(row);
    if (a.gradeLocked && input.grade !== 'again') throw fail('validation', 'grade is locked at "again" (critical error)');
    const overridden = input.overridden || (a.suggestedGrade !== null && a.suggestedGrade !== input.grade);
    const attemptId = attemptIdFor(row.id, item.id);
    const done = await rateInTx(tx, {
      id: attemptId, userId, cardId: item.cardId, subId: item.subId, sessionId: row.id, mode: item.mode, inputKind: a.inputKind,
      answerText: a.answerText, verdict: a.verdict ? { ...a.verdict, disputed: !!item.x.disputed } : null, grade: input.grade, gradeOverridden: overridden,
      durationMs: a.durationMs, createdAt,
    }, (due) => {
      const next = [...items];
      next[idx] = { ...item, x: { ...item.x, rated: { grade: input.grade, due: due.toISOString(), overridden } } };
      return { sessionId: row.id, items: next };
    }, lockedRow);
    if (item.x.reviewItemId) Object.assign(link, { reviewItemId: item.x.reviewItemId, attemptId }); // disputed before rating
    return { due: done.due, fresh: true };
  }, (tx): Promise<LockRow[]> => Promise.resolve(tx.execute<LockRow>(lockStateSql(userId, sql`
    select (i->>'cardId')::uuid, coalesce(i->>'subId', '') from sessions s cross join lateral jsonb_array_elements(s.items) i
    where s.id = ${input.sessionId} and i->>'id' = ${input.itemId}`, createdAt))));
  if (!r.ok) return r;
  if (r.data.fresh) await invalidate('review.answered', { userId }); // after COMMIT (was inside recordAttempt)
  if (link.reviewItemId && link.attemptId) await linkDispute(link.reviewItemId, link.attemptId);
  return ok({ due: r.data.due });
};

// --- dispute -----------------------------------------------------------------------------------------------------------

export const dispute: Dispute = async (userId, input) => {
  const r = await locked(userId, input.sessionId, async (tx, s, row, items) => {
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
  if (r.ok) await invalidate('review.answered', { userId }); // the attempt's verdict is now `disputed` (progress)
  return r;
};

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

export const finishSession: FinishSession = async (userId, sessionId) => {
  const r = await locked(userId, sessionId, async (tx, s, row, items) => {
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
  if (r.ok) await invalidate('review.answered', { userId }); // the session ended: stats and progress count it
  return r;
};
