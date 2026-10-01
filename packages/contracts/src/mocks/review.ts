// In-memory F03: toy scheduler with the real FSRS forgetting curve and FR-3/FR-5 rules.
import { grades, type Grade } from '../enums';
import { err, ok } from '../errors';
import type { FsrsMemory, FsrsState, IntervalPreview } from '../review';
import type {
  GetBoardQueue,
  GetDailyQueue,
  GetRetrievability,
  MapStateOf,
  Preview,
  RecordAttempt,
  Retrievability,
  Schedule,
  VerdictToGrade,
} from '../api';
import { retrievabilityFixture, reviewQueueFixture, sepseBoardId, sepseCards } from './fixtures';

const DAY = 86_400_000;
const FACTOR = 19 / 81; // FSRS-5: R(t) = (1 + FACTOR * t / S) ^ -0.5
const INITIAL: Record<Grade, number> = { again: 0.4, hard: 1.2, good: 3, easy: 8 };
const GROWTH: Record<Grade, number> = { again: 0.5, hard: 1.2, good: 2.5, easy: 4 };

export const retrievability: Retrievability = (m, now) => {
  if (!m || m.reps === 0 || m.stability <= 0) return 0;
  const t = Math.max(0, (now.getTime() - (m.lastReview ?? now).getTime()) / DAY);
  return (1 + (FACTOR * t) / m.stability) ** -0.5;
};

export const mapState: MapStateOf = (m, now) => {
  if (!m || m.reps === 0) return 'unknown';
  const r = retrievability(m, now);
  if (m.due <= now || r < 0.7) return 'review';
  return r < 0.85 ? 'watch' : 'steady';
};

export const schedule: Schedule = (m, grade, now) => {
  const stability = m && m.reps > 0 ? Math.max(0.1, m.stability * GROWTH[grade]) : INITIAL[grade];
  const days = grade === 'again' ? 0 : Math.max(1, Math.round(stability));
  const lapse = grade === 'again' && !!m && m.reps > 0;
  return {
    stability,
    difficulty: Math.min(10, Math.max(1, (m?.difficulty ?? 5) + (grade === 'again' ? 1 : grade === 'easy' ? -1 : 0))),
    due: new Date(now.getTime() + (days === 0 ? 10 * 60_000 : days * DAY)),
    reps: (m?.reps ?? 0) + 1,
    lapses: (m?.lapses ?? 0) + (lapse ? 1 : 0),
    lastReview: now,
    state: grade === 'again' ? (lapse ? 'relearning' : 'learning') : 'review',
  };
};

export const preview: Preview = (m, now) => {
  const entry = (g: Grade) => {
    const next = schedule(m, g, now);
    return { due: next.due, intervalDays: (next.due.getTime() - now.getTime()) / DAY };
  };
  return Object.fromEntries(grades.map((g) => [g, entry(g)])) as IntervalPreview;
};

export const verdictToGrade: VerdictToGrade = ({ verdict, criticalError }, { durationMs, medianMs }) => {
  if (criticalError || verdict === 'incorrect') return 'again';
  if (verdict === 'partial') return 'hard';
  return medianMs !== null && durationMs < medianMs / 2 ? 'easy' : 'good';
};

// --- server-side, in memory -----------------------------------------------
const states = new Map<string, FsrsState>();
const seenAttempts = new Map<string, FsrsState>();
export const resetReviewMocks = () => {
  states.clear();
  seenAttempts.clear();
};

export const recordAttempt: RecordAttempt = async (a) => {
  const seen = seenAttempts.get(a.id); // idempotent by attempt id
  if (seen) return ok({ state: seen, due: seen.due });
  const key = `${a.userId}|${a.cardId}|${a.subId ?? ''}`;
  const prev: FsrsMemory | null = states.get(key) ?? null;
  const state: FsrsState = { ...schedule(prev, a.grade, a.createdAt), userId: a.userId, cardId: a.cardId, subId: a.subId };
  states.set(key, state);
  seenAttempts.set(a.id, state);
  return ok({ state, due: state.due });
};

export const getDailyQueue: GetDailyQueue = async (_userId, { limit }) =>
  ok(reviewQueueFixture.slice(0, limit ?? reviewQueueFixture.length));

export const getBoardQueue: GetBoardQueue = async (_userId, boardId, { limit }) => {
  if (boardId !== sepseBoardId) return err('not_found', 'board not found');
  const ids = new Set(sepseCards.map((c) => c.id));
  return ok(reviewQueueFixture.filter((q) => ids.has(q.cardId)).slice(0, limit));
};

export const getRetrievability: GetRetrievability = async (_userId, boardId) =>
  boardId === sepseBoardId ? ok(retrievabilityFixture) : err('not_found', 'board not found');
