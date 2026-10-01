// F03 scheduler: thin, pure wrapper over ts-fsrs (default parameters, no fuzz so results are deterministic; D-056).
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade as FsrsGrade } from 'ts-fsrs';
import {
  grades, type FsrsCardState, type FsrsMemory, type Grade, type IntervalPreview, type MapState, type MapStateOf, type Preview,
  type Retrievability, type Schedule, type VerdictToGrade,
} from '@remoa/contracts';

const DAY = 86_400_000;
/** FR-5 thresholds (provisional, revisit with beta data). */
export const REVIEW_BELOW = 0.7;
export const STEADY_FROM = 0.85;

const engine = fsrs(generatorParameters({ enable_fuzz: false }));

const STATES: Record<FsrsCardState, State> = { new: State.New, learning: State.Learning, review: State.Review, relearning: State.Relearning };
const STATE_NAMES: Record<number, FsrsCardState> = { [State.New]: 'new', [State.Learning]: 'learning', [State.Review]: 'review', [State.Relearning]: 'relearning' };
const rating = (g: Grade) => (grades.indexOf(g) + 1) as FsrsGrade & Rating;

const toCard = (m: FsrsMemory): Card => ({
  due: m.due, stability: m.stability, difficulty: m.difficulty, elapsed_days: 0, scheduled_days: m.scheduledDays,
  learning_steps: m.learningSteps, reps: m.reps, lapses: m.lapses, state: STATES[m.state], last_review: m.lastReview ?? undefined,
});
const fromCard = (c: Card): FsrsMemory => ({
  stability: c.stability, difficulty: c.difficulty, due: c.due, reps: c.reps, lapses: c.lapses, lastReview: c.last_review ?? null,
  state: STATE_NAMES[c.state]!, learningSteps: c.learning_steps, scheduledDays: c.scheduled_days,
});
const cardOf = (m: FsrsMemory | null, now: Date) => (m ? toCard(m) : createEmptyCard(now));

export const schedule = ((memory, grade, now) => fromCard(engine.next(cardOf(memory, now), now, rating(grade)).card)) satisfies Schedule;

export const preview = ((memory, now) => {
  const log = engine.repeat(cardOf(memory, now), now);
  return Object.fromEntries(
    grades.map((g) => {
      const due = log[rating(g)].card.due;
      return [g, { due, intervalDays: (due.getTime() - now.getTime()) / DAY }];
    }),
  ) as IntervalPreview;
}) satisfies Preview;

/** 0 for never-reviewed cards. */
export const retrievability = ((memory, now) =>
  !memory || memory.reps === 0 || !memory.lastReview ? 0 : engine.get_retrievability(toCard(memory), now, false)) satisfies Retrievability;

const fromR = (r: number): Exclude<MapState, 'unknown'> => (r < REVIEW_BELOW ? 'review' : r < STEADY_FROM ? 'watch' : 'steady');

export const mapState = ((memory, now): MapState => {
  if (!memory || memory.reps === 0) return 'unknown';
  return memory.due <= now ? 'review' : fromR(retrievability(memory, now));
}) satisfies MapStateOf;

export const verdictToGrade = (({ verdict, criticalError }, { durationMs, medianMs }): Grade => {
  if (criticalError || verdict === 'incorrect') return 'again';
  if (verdict === 'partial') return 'hard';
  return medianMs !== null && durationMs < medianMs / 2 ? 'easy' : 'good';
}) satisfies VerdictToGrade;

/** D-057: card-level r/state from its steps or masks (unreviewed ones count as r = 0, unknown). */
export function aggregate(subs: { r: number; state: MapState }[]): { r: number; state: MapState } {
  // mean over reviewed subs only: an unstudied step means "keep an eye on it" (watch), not "you forgot it" (review)
  const seen = subs.filter((s) => s.state !== 'unknown');
  if (!seen.length) return { r: 0, state: 'unknown' };
  const r = seen.reduce((a, s) => a + s.r, 0) / seen.length;
  const base = fromR(r);
  return { r, state: base === 'steady' && subs.some((s) => s.state !== 'steady') ? 'watch' : base };
}
