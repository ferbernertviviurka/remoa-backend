import { Hono } from 'hono';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  aiAnswerInputSchema, aiAnswerItemInputSchema, aiAnswerResultSchema, aiChallengeItemPublicSchema, aiChallengeItemServerSchema,
  aiChallengeSessionPublicSchema, aiItemTypes, cardRubricServerSchema, CHALLENGE_MAX_ATTEMPTS, challengeConfigSchema, challengeFormats, challengeModes, challengeSessionStatuses, disputeVerdictInputSchema, enamedTopicOptionSchema, err,
  generateSummaryInputSchema, gradedBy as gradedByValues, grades, idSchema, mapSummaryPublicSchema, ok, parseWith, questionBankItemPublicSchema,
  questionDifficulties, questionStatuses, questionTypes, verdicts,
  type AiAnswerInput, type AiAnswerItemInput, type AiAnswerResult, type AiChallengeItemServer, type AlternativeKey, type CardRubricServer,
  type AppError, type ChallengeConfig, type ErrorCode, type GradedBy, type Grade, type Result, type Verdict,
} from '@remoa/contracts';
import { challengeLimits, numbersGrounded } from '@remoa/ai';
import type { Tx } from '@remoa/db';
import type { Env } from '../app';
import { fail } from '../app';
import { invalidate } from '../cache';
import { asServer, pgArray, run } from '../db';
import { generateQuestions, type GenerateInput, type GenerateOutput } from '../challenge-ai/generate';
import { cardContentHash, rubricFromAnswer } from '../challenge-ai/rubric';
import {
  answerHash as gradeAnswerHash, gradeAnswer, gradeBatch, publicResult,
  type CardDue, type GradeDeps, type GradeErrorCode, type GradeInput, type GradeOutcome, type GradedAttempt, type PriorAttempt, type Schedule,
} from '../challenge-ai/grade';
import {
  acceptAnswer, advance, answerHash as sessionAnswerHash, getSession, recordAttempt, sessionStore, startSession,
  type ItemRow, type SessionRow, type SessionStore,
} from '../challenge-ai/session';
import { generateSummary, listSummaries, type GenerateSummaryInput } from '../challenge-ai/summary';
import { recordAttempt as recordReview } from '../review/record-attempt';

// G25 (F32) T6: HTTP for "Desafio com IA" and "Resumo com IA" (FR-36–FR-52, D-1605, D-1611).
// The services already exist; this file wires them. Three rules hold for every handler:
//  1. the body (or query) is parsed by a strict zod schema: an unknown field is a 422;
//  2. nothing that holds reference material (correct key, expected answer, key points, rubric, reference_ref, shuffle_map) is ever
//     serialized: a response is built from the strict PUBLIC schema of its content, and a value that does not parse is a 500, not a
//     partial answer. Server items are used for grading only and never reach `Response.json`;
//  3. the rating, the verdict and the dispute flag come from the server (grade.ts, the append-only table), never from the body.

// --- Public shapes that have no contract schema yet (local, strict) -------------------------------------------------------

/** FR-34/FR-43: what the student sees when the session closes. Item text is the public stem; the reference never appears. */
export const challengeReportSchema = z
  .object({
    sessionId: idSchema,
    boardId: idSchema.nullable(),
    format: z.enum(challengeFormats),
    status: z.enum(challengeSessionStatuses),
    total: z.number().int().nonnegative(),
    score: z.object({
      correct: z.number().int().nonnegative(), partial: z.number().int().nonnegative(), incorrect: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(), unanswered: z.number().int().nonnegative(),
    }).strict(),
    items: z.array(z.object({
      itemId: idSchema,
      position: z.number().int().nonnegative(),
      type: z.enum(aiItemTypes),
      stem: z.string(),
      attemptId: idSchema.nullable(),
      attemptNo: z.number().int().min(1).max(CHALLENGE_MAX_ATTEMPTS).nullable(),
      verdict: z.enum(verdicts).nullable(),
      gradedBy: z.enum(gradedByValues).nullable(),
      rating: z.enum(grades).nullable(),
      feedback: z.string().max(2000).nullable(),
      manipulation: z.boolean(),
      disputed: z.boolean(),
    }).strict()).max(20),
  })
  .strict();
export type ChallengeReport = z.infer<typeof challengeReportSchema>;

/** FR-19/FR-8: how many questions came from the bank, how many were written now, how many are missing. Numbers only. */
export const generationMetaSchema = z
  .object({
    requested: z.number().int().nonnegative(), reused: z.number().int().nonnegative(), generated: z.number().int().nonnegative(),
    shortfall: z.number().int().nonnegative(), stoppedBy: z.enum(['quota', 'ai_error']).nullable(),
  })
  .strict();
export type GenerationMeta = z.infer<typeof generationMetaSchema>;

export const disputeResultSchema = z.object({ attemptId: idSchema, disputed: z.literal(true) }).strict();
export const archiveResultSchema = z.object({ id: idSchema, status: z.literal('archived') }).strict();
/** FR-18: a new version. The answer stays on the server; only the stem and the difficulty change. */
export const editQuestionSchema = z.object({
  stem: z.string().trim().min(1).max(2000),
  difficulty: z.enum(questionDifficulties).optional(),
}).strict();
/** FR-17: the student confirms a topic that already exists in the closed ENAMED list. */
export const confirmTopicSchema = z.object({ topicId: idSchema }).strict();
export const reportResultSchema = z.object({ itemId: idSchema, reported: z.literal(true) }).strict();

/** GET /bank query. Strict: an unknown parameter is a 422. */
export const bankQuerySchema = z
  .object({
    board: idSchema.optional(),
    /** `enamed_area_id`. */
    area: idSchema.optional(),
    difficulty: z.enum(questionDifficulties).optional(),
    type: z.enum(questionTypes).optional(),
    status: z.enum(questionStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type BankQuery = z.infer<typeof bankQuerySchema>;

/** GET /topics. Optional area: only topics of that ENAMED area. An unknown parameter is a 422. */
export const topicsQuerySchema = z.object({ areaId: idSchema.optional() }).strict();

/** Finish and dispute take no body: the only valid one is empty (or `{}`). Anything else is a 422. */
const emptyBody = z.object({}).strict();

// --- The service the routes call -----------------------------------------------------------------------------------------

/** Every method returns plain data; the route parses it with the public schema before sending. `unknown` on purpose. */
export type ChallengeAiService = {
  start(userId: string, config: ChallengeConfig, requestId: string): Promise<Result<{ session: unknown; generation: GenerationMeta | null }>>;
  session(userId: string, sessionId: string): Promise<Result<unknown>>;
  answer(userId: string, sessionId: string, body: AiAnswerItemInput, requestId: string): Promise<Result<unknown>>;
  finish(userId: string, sessionId: string, requestId: string): Promise<Result<unknown>>;
  dispute(userId: string, attemptId: string): Promise<Result<unknown>>;
  bank(userId: string, query: BankQuery): Promise<Result<unknown>>;
  archive(userId: string, bankId: string): Promise<Result<unknown>>;
  edit(userId: string, bankId: string, body: unknown): Promise<Result<unknown>>;
  confirmTopic(userId: string, bankId: string, body: unknown): Promise<Result<unknown>>;
  topics(userId: string, areaId: string | null): Promise<Result<unknown>>;
  report(userId: string, itemId: string): Promise<Result<unknown>>;
  summarize(input: GenerateSummaryInput): Promise<Result<unknown>>;
  summaries(userId: string, boardId: string): Promise<Result<unknown>>;
};

/** One attempt row as stored (reading it needs no reference column). */
export type StoredAttempt = {
  id: string; itemId: string; attemptNo: number; answer: AiAnswerInput; gradedBy: GradedBy; verdict: Verdict | null; feedback: string | null;
  hint: string | null; manipulation: boolean; covered: string[]; missing: string[]; criticalError: boolean; confidence: number | null;
  model: string | null; promptVersion: string | null; rating: Grade | null; disputed: boolean;
};

/** What the grader needs from the reference, resolved on the server from `reference_ref`. Lives only inside one request. */
export type Reference = {
  correctKey: AlternativeKey | null; expectedAnswer?: string; keyPoints?: string[]; rubric?: CardRubricServer;
  assunto: string; evidence: string; neighbors: string;
};

export type ScoreRow = { correct: number; partial: number; incorrect: number; pending: number };

/** What a final verdict does to the card and to the bank row. `schedule` is null while the student can still retry. */
export type AfterGrade = {
  cardId: string | null; subId: string; bankId: string | null; itemType: (typeof aiItemTypes)[number];
  schedule: Schedule | null; rating: Grade | null; verdict: Verdict | null; attemptId: string; elapsedMs?: number; now: Date;
};

/** The SQL that the existing services do not have: reading the reference, history, the graded row, score, dispute, bank list. */
export type DataPort = {
  attempts(userId: string, itemId: string): Promise<StoredAttempt[]>;
  sessionAttempts(userId: string, sessionId: string): Promise<StoredAttempt[]>;
  items(userId: string, sessionId: string): Promise<ItemRow[]>;
  reference(userId: string, session: SessionRow, item: AiChallengeItemServer): Promise<Reference | null>;
  recentAiGradings(userId: string, cardId: string): Promise<number>;
  /** Appends the graded row (same attempt_no as the pending one). null = that attempt was graded already (a concurrent request won). */
  saveGraded(userId: string, itemId: string, g: GradedAttempt): Promise<string | null>;
  saveScore(userId: string, sessionId: string, score: ScoreRow): Promise<void>;
  /** D-1605: flips `disputed` false -> true and nothing else. */
  dispute(userId: string, attemptId: string): Promise<Result<{ attemptId: string; disputed: true }>>;
  bank(userId: string, q: BankQuery): Promise<unknown[]>;
  /** FR-32: `new` when the card was never reviewed, `due` when the review date has passed, `not_due` otherwise. */
  cardDue(userId: string, cardId: string, subId: string, now: Date): Promise<CardDue>;
  /** Applies the schedule the grader already decided, and counts the final verdict on a bank question. Never throws into the answer. */
  afterGrade(userId: string, spec: AfterGrade): Promise<void>;
  archive(userId: string, bankId: string): Promise<{ id: string; status: 'archived' } | null>;
  /** Inserts a new row that supersedes this one. `'numbers'` when the new stem adds a dose the stored question does not have. */
  edit(userId: string, bankId: string, stem: string, difficulty?: string): Promise<unknown | 'numbers' | null>;
  /** Sets the topic only when it is a taxonomy topic of the question's area. `'closed'` = not in that list. */
  confirmTopic(userId: string, bankId: string, topicId: string): Promise<unknown | 'closed' | null>;
  /** Closed-list topic names. `areaId` limits them to that area row; null lists every topic. */
  topics(userId: string, areaId: string | null): Promise<{ id: string; name: string }[]>;
  /** FR-13: the item's card goes to the F10 queue. null when the item is not this user's. */
  report(userId: string, itemId: string): Promise<{ itemId: string; reported: true } | null>;
};

export type Io = {
  /** One transaction as the user (RLS) with the session store on it. */
  tx<T>(userId: string, fn: (store: SessionStore) => Promise<T>): Promise<T>;
  data: DataPort;
  grade: (input: GradeInput, deps?: GradeDeps) => Promise<GradeOutcome>;
  gradeBatch: (inputs: readonly GradeInput[], deps?: GradeDeps) => Promise<GradeOutcome[]>;
  generate: (input: GenerateInput) => Promise<Result<GenerateOutput>>;
  summarize: typeof generateSummary;
  summaries: typeof listSummaries;
  now: () => Date;
};

const GRADE_ERROR: Record<GradeErrorCode, ErrorCode> = {
  invalid_answer: 'validation', answer_kind_mismatch: 'validation', batch_too_large: 'validation', no_attempts_left: 'conflict', pending_grade: 'conflict',
  missing_reference: 'conflict', rate_limited: 'rate_limited', quota_exceeded: 'quota_exceeded', ai_failed: 'ai_unavailable',
};
const PUBLICO = 'estudantes de medicina do 5º e 6º ano e recém-formados que estudam para o ENAMED e a residência';

const modeOf = (s: SessionRow) => (s.params.preset === 'mock' ? 'mock' : 'train');
const maxAttempts = (s: SessionRow) => (s.params.preset === 'mock' ? 1 : CHALLENGE_MAX_ATTEMPTS);

const toPrior = (a: StoredAttempt): PriorAttempt => ({
  attemptNo: a.attemptNo, answerHash: gradeAnswerHash(a.answer), gradedBy: a.gradedBy, verdict: a.verdict, feedback: a.feedback, hint: a.hint,
  manipulation: a.manipulation, covered: a.covered, missing: a.missing, criticalError: a.criticalError, confidence: a.confidence, model: a.model,
  promptVersion: a.promptVersion,
});

const json = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

/** The item as the grader reads it. Strict parse: the reference fields are the only additions. Never serialized. */
const toServerItem = (r: ItemRow): AiChallengeItemServer =>
  aiChallengeItemServerSchema.parse({
    id: r.id, sessionId: r.sessionId, position: r.position, kind: r.kind, cardId: r.cardId, subId: r.subId || null, bankId: r.bankId, type: r.type,
    public: json(r.payloadPublic), referenceRef: json(r.referenceRef), shuffleMap: json(r.shuffleMap) ?? null,
  });

const withReference = (item: AiChallengeItemServer, ref: Reference): AiChallengeItemServer =>
  aiChallengeItemServerSchema.parse({
    ...item, correctKey: ref.correctKey, expectedAnswer: ref.expectedAnswer,
    keyPoints: ref.rubric?.essentialPoints ?? ref.keyPoints, ...(ref.rubric ? { rubric: ref.rubric } : {}),
  });

/** A stored graded row as the answer result (a repeated answer returns it: no new row, no model call). */
function storedResult(a: StoredAttempt, s: SessionRow): AiAnswerResult {
  const canRetry = a.gradedBy !== 'pending' && a.verdict !== 'correct' && !a.manipulation && a.attemptNo < maxAttempts(s) && s.params.grading === 'immediate';
  return {
    attemptId: a.id, attemptNo: a.attemptNo, verdict: a.verdict, gradedBy: a.gradedBy, rating: a.rating, feedback: a.feedback, hint: canRetry ? a.hint : null,
    canRetry, manipulation: a.manipulation,
  };
}

const pendingResult = (attemptId: string, attemptNo: number): AiAnswerResult => ({
  attemptId, attemptNo, verdict: null, gradedBy: 'pending', rating: null, feedback: null, hint: null, canRetry: false, manipulation: false,
});

const gradedOf = (all: readonly StoredAttempt[], attemptNo: number) => all.find((a) => a.attemptNo === attemptNo && a.gradedBy !== 'pending');

// --- Service over the existing modules ------------------------------------------------------------------------------------

export function createChallengeAiService(io: Io): ChallengeAiService {
  const advanceQuietly = (userId: string, sessionId: string) => io.tx(userId, (st) => advance(st, userId, sessionId, io.now())).catch(() => undefined);

  return {
    // FR-2 format 2 (map): the session service only. Format 1 (generated): the generate service first (saved questions first, the model only
    // for the shortfall, FR-19), then the session service with the questions it returned.
    async start(userId, cfg, requestId) {
      if (cfg.format === 'map') {
        const r = await io.tx(userId, (st) => startSession(st, userId, cfg, { now: io.now() }));
        return r.ok ? ok({ session: r.data, generation: null }) : r;
      }
      // FR-20 (one ENAMED topic across maps) needs a bank query by topic that is not built yet: refuse instead of ignoring the field
      if (cfg.enamedTopicId) return err('validation', 'enamed_topic_not_supported_yet');
      const gen = await io.generate({
        userId, boardId: cfg.boardId, scope: cfg.scope, n: cfg.n, questionType: cfg.questionType ?? 'mixed', difficulty: cfg.difficulty, requestId,
      });
      if (!gen.ok) return gen;
      const g = gen.data;
      if (!g.questions.length) return err('not_found', 'no_questions');
      const r = await io.tx(userId, (st) => startSession(st, userId, cfg, { bankIds: g.questions.map((q) => q.id), now: io.now() }));
      if (!r.ok) return r;
      const generation = generationMetaSchema.parse({ requested: g.requested, reused: g.reused, generated: g.generated, shortfall: g.shortfall, stoppedBy: g.stoppedBy });
      return ok({ session: r.data, generation });
    },

    session: (userId, sessionId) => io.tx(userId, (st) => getSession(st, userId, sessionId, io.now())),

    // FR-37/FR-38: the answer is stored as `pending` and committed BEFORE the model is called (no transaction open during the call);
    // the verdict goes in a new row (D-1605). The answer is accepted only for the open item of an active session.
    async answer(userId, sessionId, body, requestId) {
      const now = io.now();
      const opened = await io.tx(userId, async (st) => {
        const rec = await recordAttempt(st, userId, sessionId, body, now);
        if (!rec.ok) return rec;
        const open = await acceptAnswer(st, userId, sessionId, body.itemId, now);
        return open.ok ? ok({ rec: rec.data, session: open.data.session, item: open.data.item }) : open;
      });
      if (!opened.ok) return opened;
      const { rec, session, item } = opened.data;
      const attempts = await io.data.attempts(userId, item.id);

      const stored = gradedOf(attempts, rec.attemptNo);
      if (stored) return ok(storedResult(stored, session)); // the same answer again: the verdict already stored

      if (session.params.grading === 'end') {
        // FR-34: nothing is graded now; the pending row is graded together with the rest when the session finishes
        await advanceQuietly(userId, sessionId);
        return ok(pendingResult(rec.attemptId, rec.attemptNo));
      }

      const ref = await io.data.reference(userId, session, item);
      if (!ref) return err('conflict', 'reference_unavailable');
      const card = item.cardId ? await io.data.cardDue(userId, item.cardId, item.subId || '', now) : null;
      const outcome = await io.grade({
        userId, mode: modeOf(session), item: withReference(item, ref), answer: body.answer, card, history: attempts.map(toPrior),
        context: { assunto: ref.assunto, publico: PUBLICO, neighbors: ref.neighbors, evidence: ref.evidence },
        elapsedMs: body.elapsedMs, pending: { attemptNo: rec.attemptNo },
        gradingsLastHour: item.cardId ? await io.data.recentAiGradings(userId, item.cardId) : undefined,
      }, { requestId });
      if (!outcome.ok && outcome.error.code === 'quota_exceeded') {
        // FR-35: no AI unit left. The answer stays as the pending row; it is graded at finish, the student moves on
        await advanceQuietly(userId, sessionId);
        return ok(pendingResult(rec.attemptId, rec.attemptNo));
      }
      if (!outcome.ok) return err(GRADE_ERROR[outcome.error.code], outcome.error.code);

      const g = outcome.data;
      let attemptId = rec.attemptId;
      if (g.gradedBy !== 'pending') {
        const saved = await io.data.saveGraded(userId, item.id, g);
        if (saved) {
          attemptId = saved;
          if (g.verdict && !g.canRetry) await io.data.afterGrade(userId, {
            cardId: item.cardId, subId: item.subId || '', bankId: item.bankId, itemType: item.type, schedule: g.schedule, rating: g.rating,
            verdict: g.verdict, attemptId: saved, elapsedMs: body.elapsedMs, now,
          });
        } else {
          // another request graded this attempt first: its row is the answer
          const won = gradedOf(await io.data.attempts(userId, item.id), rec.attemptNo);
          if (won) return ok(storedResult(won, session));
        }
      }
      if (!g.canRetry) await advanceQuietly(userId, sessionId); // final for this item: the next one opens
      return ok(publicResult(attemptId, g));
    },

    // FR-34/FR-35: answers still waiting (end-of-session grading, or no AI quota at the time) are graded now, up to batchGradeMax per call;
    // then the session is closed and its score saved. Items never answered count as `unanswered`.
    async finish(userId, sessionId, requestId) {
      const now = io.now();
      const s = await io.tx(userId, (st) => st.session(userId, sessionId, false));
      if (!s) return err('not_found', 'session_not_found');
      const rows = await io.data.items(userId, sessionId);
      let attempts = await io.data.sessionAttempts(userId, sessionId);

      const waiting = rows.flatMap((row) => {
        const mine = attempts.filter((a) => a.itemId === row.id);
        const pend = mine.filter((a) => a.gradedBy === 'pending' && !gradedOf(mine, a.attemptNo)).at(-1);
        return pend ? [{ row, pend, mine }] : [];
      });
      if (waiting.length) {
        const jobs: { row: ItemRow; input: GradeInput }[] = [];
        for (const w of waiting) {
          const ref = await io.data.reference(userId, s, toServerItem(w.row));
          if (!ref) continue;
          jobs.push({
            row: w.row,
            input: {
              userId, mode: modeOf(s), item: withReference(toServerItem(w.row), ref), answer: w.pend.answer,
              card: w.row.cardId ? await io.data.cardDue(userId, w.row.cardId, w.row.subId || '', now) : null, history: w.mine.map(toPrior),
              context: { assunto: ref.assunto, publico: PUBLICO, neighbors: ref.neighbors, evidence: ref.evidence }, pending: { attemptNo: w.pend.attemptNo },
            },
          });
        }
        const size = Math.max(1, challengeLimits().batchGradeMax);
        for (let i = 0; i < jobs.length; i += size) {
          const chunk = jobs.slice(i, i + size);
          const outs = await io.gradeBatch(chunk.map((j) => j.input), { requestId });
          for (const [k, o] of outs.entries()) {
            if (!o.ok || o.data.gradedBy === 'pending') continue;
            const row = chunk[k]!.row;
            const saved = await io.data.saveGraded(userId, row.id, o.data);
            if (saved && o.data.verdict && !o.data.canRetry) await io.data.afterGrade(userId, {
              cardId: row.cardId, subId: row.subId || '', bankId: row.bankId, itemType: row.type, schedule: o.data.schedule, rating: o.data.rating,
              verdict: o.data.verdict, attemptId: saved, now,
            });
          }
        }
        attempts = await io.data.sessionAttempts(userId, sessionId);
      }

      const score = { correct: 0, partial: 0, incorrect: 0, pending: 0, unanswered: 0 };
      const items = rows.map((row): ChallengeReport['items'][number] => {
        const pub = aiChallengeItemPublicSchema.parse(json(row.payloadPublic));
        const mine = attempts.filter((a) => a.itemId === row.id);
        const top = Math.max(0, ...mine.map((a) => a.attemptNo));
        const last = mine.filter((a) => a.attemptNo === top);
        const final = last.find((a) => a.gradedBy !== 'pending') ?? last[0];
        if (!final) score.unanswered++;
        else if (!final.verdict) score.pending++;
        else score[final.verdict]++;
        return {
          itemId: row.id, position: row.position, type: pub.type, stem: pub.stem, attemptId: final?.id ?? null, attemptNo: final?.attemptNo ?? null,
          verdict: final?.verdict ?? null, gradedBy: final?.gradedBy ?? null, rating: final?.rating ?? null, feedback: final?.feedback ?? null,
          manipulation: final?.manipulation ?? false, disputed: final?.disputed ?? false,
        };
      });

      if (s.status !== 'expired') {
        await io.tx(userId, (st) => (s.status === 'active' ? st.moveTo(userId, sessionId, s.total, now) : Promise.resolve()));
        await io.data.saveScore(userId, sessionId, { correct: score.correct, partial: score.partial, incorrect: score.incorrect, pending: score.pending });
      }
      return ok({
        sessionId: s.id, boardId: s.boardId, format: s.format, status: s.status === 'active' ? 'finished' : s.status, total: s.total, score, items,
      } satisfies ChallengeReport);
    },

    dispute: (userId, attemptId) => io.data.dispute(userId, attemptId),
    bank: async (userId, query) => ok(await io.data.bank(userId, query)),
    archive: async (userId, bankId) => {
      const row = await io.data.archive(userId, bankId);
      return row ? ok(row) : err('not_found', 'question_not_found');
    },
    edit: async (userId, bankId, body) => {
      const parsed = parseWith(editQuestionSchema, body);
      if (!parsed.ok) return parsed;
      const row = await io.data.edit(userId, bankId, parsed.data.stem, parsed.data.difficulty);
      if (row === 'numbers') return err('validation', 'ungrounded_number');
      return row ? ok(row) : err('not_found', 'question_not_found');
    },
    confirmTopic: async (userId, bankId, body) => {
      const parsed = parseWith(confirmTopicSchema, body);
      if (!parsed.ok) return parsed;
      const row = await io.data.confirmTopic(userId, bankId, parsed.data.topicId);
      if (row === 'closed') return err('validation', 'topic_not_in_list');
      return row ? ok(row) : err('not_found', 'question_not_found');
    },
    topics: async (userId, areaId) => ok(await io.data.topics(userId, areaId)),
    report: async (userId, itemId) => {
      const row = await io.data.report(userId, itemId);
      return row ? ok(row) : err('not_found', 'item_not_found');
    },
    summarize: (input) => io.summarize(input),
    summaries: (userId, boardId) => io.summaries(userId, boardId),
  };
}

// --- SQL (server connection where `authenticated` has no grant) -------------------------------------------------------------

type Raw = Record<string, unknown>;
const exec = async <R extends Raw>(tx: Tx, q: SQL) => (await tx.execute<R>(q)) as unknown as R[];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (s: string, n = 1500) => s.slice(0, n);

const ATTEMPT_COLUMNS = sql`id, item_id, attempt_no, answer, verdict, covered, missing, critical_error, manipulation, feedback, hint, confidence, graded_by, model,
  prompt_version, rating, disputed`;
const toStored = (r: Raw): StoredAttempt => ({
  id: String(r.id), itemId: String(r.item_id), attemptNo: Number(r.attempt_no), answer: aiAnswerInputSchema.parse(json(r.answer)), gradedBy: r.graded_by as GradedBy,
  verdict: (r.verdict as Verdict | null) ?? null, feedback: (r.feedback as string | null) ?? null, hint: (r.hint as string | null) ?? null,
  manipulation: Boolean(r.manipulation), covered: strs(r.covered), missing: strs(r.missing), criticalError: Boolean(r.critical_error),
  confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence), model: (r.model as string | null) ?? null,
  promptVersion: (r.prompt_version as string | null) ?? null, rating: (r.rating as Grade | null) ?? null, disputed: Boolean(r.disputed),
});

/** Public bank row. The name is the taxonomy label, never the answer. */
const publicBank = (r: Raw) => ({
  id: r.id, boardId: r.board_id, type: r.type, difficulty: r.difficulty, stem: r.stem, source: r.source, status: r.status,
  enamedAreaId: r.enamed_area_id, enamedDomainId: r.enamed_domain_id, enamedTopicId: r.enamed_topic_id,
  enamedTopicName: typeof r.enamed_topic_name === 'string' && r.enamed_topic_name ? r.enamed_topic_name : null,
  enamedConfirmed: Boolean(r.enamed_confirmed),
  stats: json(r.stats), createdAt: r.created_at,
});

export const dbData: DataPort = {
  // covered, missing and hint have no SELECT grant for authenticated (D-1633). The grader reads them as the server role.
  attempts: (userId, itemId) => run(userId, async (tx) =>
    (await asServer<Raw>(tx, sql`select ${ATTEMPT_COLUMNS} from challenge_attempts where item_id = ${itemId} and user_id = ${userId} order by attempt_no, created_at`)).map(toStored)),

  sessionAttempts: (userId, sessionId) => run(userId, async (tx) =>
    (await asServer<Raw>(tx, sql`select ${ATTEMPT_COLUMNS} from challenge_attempts where user_id = ${userId}
      and item_id in (select id from challenge_items where session_id = ${sessionId} and user_id = ${userId}) order by attempt_no, created_at`)).map(toStored)),

  items: (userId, sessionId) => run(userId, async (tx) =>
    (await asServer<Raw>(tx, sql`select id, session_id, position, kind, card_id, sub_id, bank_id, type, payload_public, reference_ref, shuffle_map
      from challenge_items where session_id = ${sessionId} and user_id = ${userId} order by position`)).map((r): ItemRow => ({
      id: String(r.id), sessionId: String(r.session_id), position: Number(r.position), kind: r.kind as ItemRow['kind'], cardId: (r.card_id as string | null) ?? null,
      subId: String(r.sub_id ?? ''), bankId: (r.bank_id as string | null) ?? null, type: r.type as ItemRow['type'], payloadPublic: r.payload_public,
      referenceRef: r.reference_ref, shuffleMap: r.shuffle_map ?? null,
    }))),

  // The reference is read here, on the server, for one grading, and returned to the caller of this function only.
  reference: (userId, session, item) => run(userId, async (tx) => {
    const [board] = session.boardId ? await exec(tx, sql`select title from boards where id = ${session.boardId}`) : [];
    const assunto = text(board?.title) ?? 'Desafio';
    const ref = item.referenceRef;
    if (ref.kind === 'bank') {
      const [q] = await asServer<Raw>(tx, sql`select correct_key, expected_answer, key_points, evidences from question_bank where id = ${ref.bankId} and user_id = ${userId}`);
      if (!q) return null;
      const evidence = (Array.isArray(json(q.evidences)) ? (json(q.evidences) as unknown[]) : []).map((e) => text(rec(e).excerpt)).filter((s): s is string => s !== null).join('\n');
      return {
        correctKey: (q.correct_key as AlternativeKey | null) ?? null, expectedAnswer: String(q.expected_answer), keyPoints: strs(q.key_points), assunto,
        evidence: clip(evidence), neighbors: '',
      };
    }
    const [card] = await exec(tx, sql`select title, front, back, payload, didactics from cards where id = ${ref.cardId}`);
    if (!card) return null;
    const payload = rec(json(card.payload));
    let expected: string | null = null;
    if (item.type === 'hidden_card') expected = text(card.back);
    else if (item.type === 'edge') {
      const edgeId = (ref.subId ?? '').replace(/^edge:/, '');
      if (idSchema.safeParse(edgeId).success) expected = text((await exec(tx, sql`select label from edges where id = ${edgeId}`))[0]?.label);
    } else if (item.type === 'case') {
      expected = text(rec((Array.isArray(payload.caseSteps) ? payload.caseSteps : []).find((s) => rec(s).stage === ref.subId)).text);
    } else if (item.type === 'occlusion') {
      expected = text(rec((Array.isArray(payload.masks) ? payload.masks : []).find((m) => rec(m).id === ref.subId)).label);
    }
    if (!expected && item.type !== 'next_step') return null;
    const didactics = rec(json(card.didactics));
    const hash = cardContentHash(text(card.front), text(card.back), text(didactics.porQue));
    const [stored] = await asServer<Raw>(tx, sql`select essential_points, accepted_variants, critical_errors, status from card_rubrics
      where card_id = ${ref.cardId} and card_hash = ${hash} order by created_at desc limit 1`);
    const parsedRubric = stored ? cardRubricServerSchema.safeParse({
      essentialPoints: strs(stored.essential_points), acceptedVariants: strs(stored.accepted_variants),
      criticalErrors: strs(stored.critical_errors), status: stored.status,
    }) : null;
    const rubric = parsedRubric?.success ? parsedRubric.data : expected ? rubricFromAnswer(expected) ?? undefined : undefined;
    const near = await exec(tx, sql`select c2.title from edges e join cards c2 on c2.id = case when e.from_card_id = ${ref.cardId} then e.to_card_id else e.from_card_id end
      where (e.from_card_id = ${ref.cardId} or e.to_card_id = ${ref.cardId}) and c2.deleted_at is null limit 5`);
    return {
      correctKey: null, expectedAnswer: expected ?? undefined, keyPoints: rubric?.essentialPoints, rubric, assunto,
      neighbors: near.map((n) => String(n.title)).join('; '),
      evidence: clip([text(card.title), text(card.front), text(card.back)].filter((s): s is string => s !== null).join('\n')),
    };
  }),

  recentAiGradings: (userId, cardId) => run(userId, async (tx) => {
    const [r] = await exec(tx, sql`select count(*)::int as n from challenge_attempts a join challenge_items i on i.id = a.item_id and i.user_id = a.user_id
      where a.user_id = ${userId} and i.card_id = ${cardId} and a.graded_by = 'ai' and a.created_at > now() - interval '1 hour'`);
    return Number(r?.n ?? 0);
  }),

  // `answer_hash` here is the session's hash (same as the pending row), so "the same answer again" is found by recordAttempt
  saveGraded: async (userId, itemId, g) => {
    const id = await run(userId, async (tx) => {
      const [r] = await asServer<Raw>(tx, sql`insert into challenge_attempts (item_id, user_id, attempt_no, answer, answer_hash, verdict, covered, missing, critical_error,
          manipulation, feedback, hint, used_hint, confidence, graded_by, model, prompt_version, latency_ms, rating)
        values (${itemId}, ${userId}, ${g.attemptNo}, ${JSON.stringify(g.answer)}::jsonb, ${sessionAnswerHash(g.answer)}, ${g.verdict}, ${pgArray(g.covered, 'text')},
          ${pgArray(g.missing, 'text')}, ${g.criticalError}, ${g.manipulation}, ${g.feedback}, ${g.hint}, ${g.usedHint}, ${g.confidence}, ${g.gradedBy}, ${g.model},
          ${g.promptVersion}, ${g.latencyMs === null ? null : Math.round(g.latencyMs)}, ${g.rating})
        on conflict do nothing returning id`);
      return r ? String(r.id) : null;
    });
    await invalidate('challenge.finished', { userId });
    return id;
  },

  saveScore: async (userId, sessionId, score) => {
    await run(userId, async (tx) => {
      await asServer(tx, sql`update challenge_sessions set score = ${JSON.stringify(score)}::jsonb where id = ${sessionId} and user_id = ${userId}`);
    });
    await invalidate('challenge.finished', { userId });
  },

  dispute: async (userId, attemptId) => {
    const result = await run(userId, async (tx) => {
      const [a] = await exec(tx, sql`select graded_by, disputed from challenge_attempts where id = ${attemptId} and user_id = ${userId}`);
      if (!a) return err('not_found', 'attempt_not_found');
      if (a.graded_by === 'pending') return err('conflict', 'only_graded_answers');
      // the append-only trigger lets exactly this UPDATE through (disputed false -> true); no grade, verdict or text is touched
      if (!a.disputed) await asServer(tx, sql`update challenge_attempts set disputed = true where id = ${attemptId} and user_id = ${userId} and not disputed and graded_by <> 'pending'`);
      return ok({ attemptId, disputed: true as const });
    });
    if (result.ok) await invalidate('challenge.finished', { userId });
    return result;
  },

  // FR-18: only the columns `authenticated` may read (no correct_key, expected_answer, key_points, explanation, distractor_notes), latest versions only
  bank: (userId, q) => run(userId, async (tx) => {
    const where: SQL[] = [sql`q.user_id = ${userId}`, sql`not exists (select 1 from question_bank n where n.supersedes_id = q.id)`];
    if (q.board) where.push(sql`q.board_id = ${q.board}`);
    if (q.area) where.push(sql`q.enamed_area_id = ${q.area}`);
    if (q.difficulty) where.push(sql`q.difficulty = ${q.difficulty}`);
    if (q.type) where.push(sql`q.type = ${q.type}`);
    where.push(q.status ? sql`q.status = ${q.status}` : sql`q.status <> 'archived'`);
    const rows = await exec(tx, sql`select q.id, q.board_id, q.type, q.difficulty, q.stem, q.source, q.status, q.enamed_area_id, q.enamed_domain_id, q.enamed_topic_id,
        q.enamed_confirmed, t.name as enamed_topic_name, q.stats, q.created_at
      from question_bank q
      left join enamed_taxonomy t on t.id = q.enamed_topic_id
      where ${sql.join(where, sql` and `)} order by q.created_at desc, q.id limit ${q.limit} offset ${q.offset}`);
    return rows.map(publicBank);
  }),

  cardDue: async (userId, cardId, subId, now) => {
    const [r] = await run(userId, (tx) => exec(tx, sql`select reps, due from fsrs_state
      where user_id = ${userId} and card_id = ${cardId} and sub_id = ${subId}`));
    if (!r || Number(r.reps) === 0) return 'new';
    return new Date(String(r.due)) <= now ? 'due' : 'not_due';
  },

  afterGrade: async (userId, spec) => {
    const { schedule, cardId, verdict, rating } = spec;
    if (schedule && cardId && rating && verdict) {
      if (schedule.apply) {
        const mode = (challengeModes as readonly string[]).includes(spec.itemType) ? spec.itemType as (typeof challengeModes)[number] : 'hidden_card';
        const reviewed = await recordReview({
          id: spec.attemptId, userId, cardId, subId: spec.subId || null, sessionId: null, mode,
          inputKind: spec.itemType === 'objective' ? 'mcq' : 'text', answerText: null, verdict: null, grade: rating, gradeOverridden: false,
          durationMs: spec.elapsedMs ?? 0, createdAt: spec.now,
        });
        if (!reviewed.ok) return;
      } else if (schedule.anticipate) {
        await run(userId, (tx) => tx.execute(sql`update fsrs_state set due = now()
          where user_id = ${userId} and card_id = ${cardId} and sub_id = ${spec.subId} and due > now()`));
        await invalidate('review.answered', { userId });
      }
    }
    if (spec.bankId && verdict) {
      await run(userId, (tx) => asServer(tx, sql`update question_bank set stats = jsonb_build_object(
          'seen', coalesce((stats->>'seen')::int, 0) + 1,
          'correct', coalesce((stats->>'correct')::int, 0) + (${verdict} = 'correct')::int,
          'partial', coalesce((stats->>'partial')::int, 0) + (${verdict} = 'partial')::int,
          'incorrect', coalesce((stats->>'incorrect')::int, 0) + (${verdict} = 'incorrect')::int
        ) where id = ${spec.bankId} and user_id = ${userId}`));
      await invalidate('question.changed', { userId });
    }
  },

  archive: async (userId, id) => {
    const [r] = await run(userId, (tx) => asServer<Raw>(tx, sql`update question_bank set status = 'archived'
      where id = ${id} and user_id = ${userId}
        and not exists (select 1 from question_bank n where n.supersedes_id = question_bank.id)
      returning id, board_id`));
    if (!r) return null;
    await invalidate('question.changed', { userId, mapId: r.board_id ? String(r.board_id) : undefined });
    return { id: String(r.id), status: 'archived' as const };
  },

  edit: async (userId, id, stem, difficulty) => {
    const written = await run(userId, async (tx) => {
      const [prev] = await asServer<Raw>(tx, sql`select to_jsonb(q) as row from question_bank q
        where q.id = ${id} and q.user_id = ${userId} and q.status <> 'archived'
          and not exists (select 1 from question_bank n where n.supersedes_id = q.id)`);
      if (!prev) return null;
      if (!numbersGrounded([stem], [JSON.stringify(prev.row)])) return 'numbers' as const;
      const [row] = await asServer<Raw>(tx, sql`insert into question_bank (
          user_id, board_id, board_version, card_ids, type, difficulty, stem, alternatives, correct_key, expected_answer, key_points,
          explanation, distractor_notes, evidences, enamed_area_id, enamed_domain_id, enamed_competency_id, enamed_topic_id,
          enamed_confidence, enamed_confirmed, source, prompt_id, prompt_version, model, status, version, supersedes_id)
        select user_id, board_id, board_version, card_ids, type, coalesce(${difficulty ?? null}, difficulty), ${stem}, alternatives, correct_key,
          expected_answer, key_points, explanation, distractor_notes, evidences, enamed_area_id, enamed_domain_id, enamed_competency_id,
          enamed_topic_id, enamed_confidence, enamed_confirmed, source, prompt_id, prompt_version, model, 'draft', version + 1, id
        from question_bank q
        where q.id = ${id} and q.user_id = ${userId}
        returning id, board_id, type, difficulty, stem, source, status, enamed_area_id, enamed_domain_id, enamed_topic_id, enamed_confirmed,
          (select name from enamed_taxonomy where id = question_bank.enamed_topic_id) as enamed_topic_name, stats, created_at`);
      return row ?? null;
    });
    if (written === 'numbers' || !written) return written;
    await invalidate('question.changed', { userId, mapId: written.board_id ? String(written.board_id) : undefined });
    return publicBank(written);
  },

  confirmTopic: async (userId, id, topicId) => {
    const written = await run(userId, async (tx) => {
      const [mine] = await exec(tx, sql`select id from question_bank q
        where q.id = ${id} and q.user_id = ${userId} and q.status <> 'archived'
          and not exists (select 1 from question_bank n where n.supersedes_id = q.id)`);
      if (!mine) return null;
      const [row] = await asServer<Raw>(tx, sql`update question_bank q
        set enamed_topic_id = t.id,
            enamed_area_id = coalesce(q.enamed_area_id, (select a.id from enamed_taxonomy a where a.kind = 'area' and a.code = t.area::text limit 1)),
            enamed_domain_id = case when d.kind = 'domain' then d.id else q.enamed_domain_id end,
            enamed_confirmed = true
        from enamed_taxonomy t
        left join enamed_taxonomy d on d.id = t.parent_id
        where q.id = ${id} and q.user_id = ${userId}
          and t.id = ${topicId} and t.kind = 'topic'
          and (q.enamed_area_id is null or t.area = (select area from enamed_taxonomy where id = q.enamed_area_id))
        returning q.id, q.board_id, q.type, q.difficulty, q.stem, q.source, q.status, q.enamed_area_id, q.enamed_domain_id, q.enamed_topic_id,
          q.enamed_confirmed, t.name as enamed_topic_name, q.stats, q.created_at`);
      return row ?? ('closed' as const);
    });
    if (!written || written === 'closed') return written;
    await invalidate('question.changed', { userId, mapId: written.board_id ? String(written.board_id) : undefined });
    return publicBank(written);
  },

  topics: (userId, areaId) => run(userId, async (tx) => {
    const area = areaId ? sql`and t.area = (select area from enamed_taxonomy where id = ${areaId} and kind = 'area')` : sql``;
    const rows = await exec(tx, sql`select t.id, t.name from enamed_taxonomy t where t.kind = 'topic' ${area} order by t.name, t.id limit 200`);
    return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
  }),

  report: async (userId, itemId) => {
    const queued = await run(userId, async (tx) => {
      const [item] = await exec(tx, sql`select card_id, bank_id from challenge_items where id = ${itemId} and user_id = ${userId}`);
      if (!item) return null;
      let cardId = item.card_id ? String(item.card_id) : null;
      if (!cardId && item.bank_id) {
        const [q] = await asServer<Raw>(tx, sql`select card_ids from question_bank where id = ${item.bank_id} and user_id = ${userId}`);
        const ids = Array.isArray(q?.card_ids) ? q.card_ids : [];
        cardId = typeof ids[0] === 'string' ? ids[0] : null;
      }
      if (!cardId) return null;
      await tx.execute(sql`insert into review_queue (card_id, status, flag_source, note)
        values (${cardId}::uuid, 'pending', 'user_disagree', 'Reportado no desafio com IA.')`);
      return { itemId, reported: true as const };
    });
    return queued;
  },
};

export const dbIo = (): Io => ({
  tx: async (userId, fn) => {
    const result = await run(userId, (tx) => fn(sessionStore(tx)));
    await invalidate('challenge.finished', { userId });
    return result;
  },
  data: dbData,
  grade: gradeAnswer,
  gradeBatch,
  generate: generateQuestions,
  summarize: generateSummary,
  summaries: listSummaries,
  now: () => new Date(),
});

// --- Per-user cap on the calls that spend AI (rule 5) -------------------------------------------------------------------------

const MINUTE = 60_000;
export const AI_CALLS_PER_MINUTE = 30;
const hits = new Map<string, number[]>();
/** ponytail: per process, in memory (same as uploads/rate-limit.ts). The plan quotas (reserveAi) are the real cap; this stops a burst. */
export function takeAiSlot(userId: string, now = Date.now()): Result<null> {
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.every((t) => now - t >= MINUTE)) hits.delete(k);
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < MINUTE);
  if (recent.length >= AI_CALLS_PER_MINUTE) {
    hits.set(userId, recent);
    return err('rate_limited', 'too many AI calls, try again in a minute');
  }
  hits.set(userId, [...recent, now]);
  return ok(null);
}

// --- Routes ----------------------------------------------------------------------------------------------------------------

const errorResponse = (e: AppError) => {
  const res = fail(e);
  if (e.code === 'rate_limited') res.headers.set('retry-after', '60');
  return res;
};

/**
 * `data` goes through the public schema before it is sent. A value that does not parse (a reference field planted in it, a wrong shape)
 * is a 500 with no body from the value: the log gets the route and the issue paths, never the data.
 */
function sendPublic<S extends z.ZodTypeAny>(c: { get: (k: 'log') => Env['Variables']['log'] }, route: string, schema: S, r: Result<unknown>, extra: Record<string, unknown> = {}) {
  if (!r.ok) return errorResponse(r.error);
  const parsed = schema.safeParse(r.data);
  if (!parsed.success) {
    c.get('log').error('challenge_ai_public_schema', { route, paths: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
    return fail({ code: 'internal', message: 'internal error' });
  }
  return Response.json({ ok: true, data: parsed.data, ...extra });
}

const readJson = async (c: { req: { text: () => Promise<string> } }): Promise<unknown> => {
  const raw = await c.req.text().catch(() => '');
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const paramId = (v: string) => (idSchema.safeParse(v).success ? v : null);
const notFound = (what: string) => fail({ code: 'not_found', message: what });

export const challengeAiRoutes = (service: ChallengeAiService = createChallengeAiService(dbIo())) => {
  const spendsAi = (userId: string) => {
    const slot = takeAiSlot(userId);
    return slot.ok ? null : errorResponse(slot.error);
  };
  return new Hono<Env>()
    // FR-37. The session as the student sees it: only the open item, never the queue.
    .post('/sessions', async (c) => {
      const i = parseWith(challengeConfigSchema, (await readJson(c)) ?? null);
      if (!i.ok) return errorResponse(i.error);
      const limited = spendsAi(c.get('userId'));
      if (limited) return limited;
      const r = await service.start(c.get('userId'), i.data, c.get('requestId'));
      if (!r.ok) return errorResponse(r.error);
      return sendPublic(c, 'start', aiChallengeSessionPublicSchema, ok(r.data.session), r.data.generation ? { generation: generationMetaSchema.parse(r.data.generation) } : {});
    })
    .get('/sessions/:id', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('session not found');
      return sendPublic(c, 'session', aiChallengeSessionPublicSchema, await service.session(c.get('userId'), id));
    })
    // FR-38/FR-31: only the public result (verdict, rating, feedback, hint). The rating is the server's.
    .post('/sessions/:id/answers', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('session not found');
      const i = parseWith(aiAnswerItemInputSchema, (await readJson(c)) ?? null);
      if (!i.ok) return errorResponse(i.error);
      const limited = spendsAi(c.get('userId'));
      if (limited) return limited;
      return sendPublic(c, 'answer', aiAnswerResultSchema, await service.answer(c.get('userId'), id, i.data, c.get('requestId')));
    })
    .post('/sessions/:id/finish', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('session not found');
      const body = parseWith(emptyBody, (await readJson(c)) ?? {});
      if (!body.ok) return errorResponse(body.error);
      const limited = spendsAi(c.get('userId'));
      if (limited) return limited;
      return sendPublic(c, 'finish', challengeReportSchema, await service.finish(c.get('userId'), id, c.get('requestId')));
    })
    // D-1605: the flag only. No body, no grade edit.
    .post('/attempts/:id/dispute', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('attempt not found');
      const raw = (await readJson(c)) ?? {};
      const named = disputeVerdictInputSchema.safeParse(raw);
      if (!emptyBody.safeParse(raw).success && !named.success) {
        const body = parseWith(disputeVerdictInputSchema, raw);
        if (!body.ok) return errorResponse(body.error);
      }
      if (named.success && named.data.attemptId !== id) return errorResponse({ code: 'validation', message: 'attempt_mismatch' });
      return sendPublic(c, 'dispute', disputeResultSchema, await service.dispute(c.get('userId'), id));
    })
    // FR-18: the caller's own questions, without the reference.
    .get('/topics', async (c) => {
      const q = parseWith(topicsQuerySchema, c.req.query());
      if (!q.ok) return errorResponse(q.error);
      return sendPublic(c, 'topics', z.array(enamedTopicOptionSchema).max(200), await service.topics(c.get('userId'), q.data.areaId ?? null));
    })
    .get('/bank', async (c) => {
      const q = parseWith(bankQuerySchema, c.req.query());
      if (!q.ok) return errorResponse(q.error);
      return sendPublic(c, 'bank', z.array(questionBankItemPublicSchema).max(100), await service.bank(c.get('userId'), q.data), { page: { limit: q.data.limit, offset: q.data.offset } });
    })
    .post('/bank/:id/archive', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('question not found');
      const body = parseWith(emptyBody, (await readJson(c)) ?? {});
      if (!body.ok) return errorResponse(body.error);
      return sendPublic(c, 'archive', archiveResultSchema, await service.archive(c.get('userId'), id));
    })
    .post('/bank/:id/confirm', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('question not found');
      const body = parseWith(confirmTopicSchema, (await readJson(c)) ?? null);
      if (!body.ok) return errorResponse(body.error);
      return sendPublic(c, 'confirm', questionBankItemPublicSchema, await service.confirmTopic(c.get('userId'), id, body.data));
    })
    .post('/bank/:id', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('question not found');
      return sendPublic(c, 'edit', questionBankItemPublicSchema, await service.edit(c.get('userId'), id, (await readJson(c)) ?? null));
    })
    .post('/items/:id/report', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('item not found');
      const body = parseWith(emptyBody, (await readJson(c)) ?? {});
      if (!body.ok) return errorResponse(body.error);
      return sendPublic(c, 'report', reportResultSchema, await service.report(c.get('userId'), id));
    })
    // FR-46: one `ai_summaries` unit is taken inside the service.
    .post('/summaries', async (c) => {
      const i = parseWith(generateSummaryInputSchema, (await readJson(c)) ?? null);
      if (!i.ok) return errorResponse(i.error);
      const limited = spendsAi(c.get('userId'));
      if (limited) return limited;
      return sendPublic(c, 'summarize', mapSummaryPublicSchema, await service.summarize({ ...i.data, userId: c.get('userId'), requestId: c.get('requestId') }));
    })
    // FR-50: history, newest first; `stale` once the map changed.
    .get('/boards/:id/summaries', async (c) => {
      const id = paramId(c.req.param('id'));
      if (!id) return notFound('board not found');
      return sendPublic(c, 'summaries', z.array(mapSummaryPublicSchema).max(20), await service.summaries(c.get('userId'), id));
    });
};
