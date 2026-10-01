import { createEmptyCard, fsrs, generatorParameters, type Grade as G } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { grades, type FsrsMemory, type Grade } from '@remoa/contracts';
import { aggregate, mapState, preview, retrievability, schedule, verdictToGrade } from './index';

const DAY = 86_400_000;
const t0 = new Date('2026-03-01T12:00:00Z');
const at = (d: number) => new Date(t0.getTime() + d * DAY);
const ref = fsrs(generatorParameters({ enable_fuzz: false }));

describe('schedule vs ts-fsrs', () => {
  it('first review of every grade matches the reference engine', () => {
    const log = ref.repeat(createEmptyCard(t0), t0);
    grades.forEach((g, i) => {
      const c = log[(i + 1) as G].card;
      const m = schedule(null, g, t0);
      expect(m).toMatchObject({ stability: c.stability, difficulty: c.difficulty, due: c.due, reps: 1, lapses: c.lapses, lastReview: t0, learningSteps: c.learning_steps, scheduledDays: c.scheduled_days });
      expect(m.state).toBe(['learning', 'learning', 'learning', 'review'][i]);
    });
  });

  it('a chain good, good, again, easy matches the reference and round-trips through memory', () => {
    let m: FsrsMemory | null = null;
    let c = createEmptyCard(t0);
    let now = t0;
    ([ 'good', 'good', 'again', 'easy' ] as Grade[]).forEach((g, i) => {
      now = new Date(Math.max(now.getTime(), c.due.getTime()) + i * 1000);
      m = schedule(m, g, now);
      c = ref.next(c, now, (grades.indexOf(g) + 1) as G).card;
      expect(m).toMatchObject({ stability: c.stability, difficulty: c.difficulty, due: c.due, reps: c.reps, lapses: c.lapses });
    });
    expect(m!.lapses).toBe(1);
  });

  it('lapse puts a review card in relearning', () => {
    const m = schedule(schedule(schedule(null, 'easy', t0), 'good', at(10)), 'again', at(40));
    expect(m.state).toBe('relearning');
    expect(m.lapses).toBe(1);
  });
});

describe('preview', () => {
  it('gives due and interval for the 4 grades, ordered, matching schedule', () => {
    const m = schedule(null, 'easy', t0);
    const p = preview(m, at(8));
    expect(p.again.intervalDays).toBeLessThan(p.hard.intervalDays);
    expect(p.hard.intervalDays).toBeLessThan(p.good.intervalDays);
    expect(p.good.intervalDays).toBeLessThan(p.easy.intervalDays);
    for (const g of grades) expect(p[g].due).toEqual(schedule(m, g, at(8)).due);
    expect(p.good.intervalDays).toBeCloseTo((p.good.due.getTime() - at(8).getTime()) / DAY, 10);
  });
  it('works for a never-reviewed card', () => {
    expect(preview(null, t0).easy.intervalDays).toBeGreaterThan(1);
  });
});

describe('retrievability and mapState (FR-5)', () => {
  const m = schedule(schedule(null, 'easy', t0), 'good', at(8));
  const s = m.stability;
  it('0 and unknown without reviews', () => {
    expect(retrievability(null, t0)).toBe(0);
    expect(mapState(null, t0)).toBe('unknown');
    const fresh: FsrsMemory = { ...m, reps: 0 };
    expect(retrievability(fresh, t0)).toBe(0);
    expect(mapState(fresh, t0)).toBe('unknown');
    expect(retrievability({ ...m, lastReview: null }, t0)).toBe(0);
  });
  it('matches ts-fsrs and decays', () => {
    const card = { due: m.due, stability: m.stability, difficulty: m.difficulty, elapsed_days: 0, scheduled_days: m.scheduledDays, learning_steps: 0, reps: m.reps, lapses: m.lapses, state: 2, last_review: m.lastReview! };
    expect(retrievability(m, at(12))).toBe(ref.get_retrievability(card, at(12), false));
    expect(retrievability(m, at(8))).toBeCloseTo(1, 1);
    expect(retrievability(m, at(8 + s))).toBeLessThan(retrievability(m, at(8 + s / 2)));
  });
  it('thresholds: steady >= .85, watch .70-.85, review < .70, due always review', () => {
    const base: FsrsMemory = { ...m, due: at(1000) };
    const rAt = (d: number) => retrievability(base, at(8 + d));
    const days = (r: number) => { let lo = 0, hi = 1e5; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (rAt(mid) > r) lo = mid; else hi = mid; } return lo; };
    expect(mapState(base, at(8 + days(0.86)))).toBe('steady');
    expect(mapState(base, at(8 + days(0.8)))).toBe('watch');
    expect(mapState(base, at(8 + days(0.6)))).toBe('review');
    expect(mapState({ ...base, due: at(8) }, at(8))).toBe('review');
  });
});

describe('verdictToGrade (FR-3)', () => {
  const v = (verdict: 'correct' | 'partial' | 'incorrect', criticalError = false) => ({ verdict, criticalError });
  it.each([
    [v('incorrect'), 1000, null, 'again'],
    [v('partial'), 1000, null, 'hard'],
    [v('correct'), 1000, null, 'good'],
    [v('correct'), 1000, 3000, 'easy'],
    [v('correct'), 1500, 3000, 'good'],
    [v('correct'), 2000, 3000, 'good'],
    [v('correct', true), 1, 3000, 'again'],
    [v('partial', true), 1000, null, 'again'],
  ] as const)('%j %i/%s -> %s', (verdict, durationMs, medianMs, want) => {
    expect(verdictToGrade(verdict, { durationMs, medianMs })).toBe(want);
  });
});

describe('aggregate (D-057)', () => {
  const sub = (r: number, state: 'review' | 'watch' | 'steady' | 'unknown') => ({ r, state });
  it('all unknown or empty -> unknown', () => {
    expect(aggregate([sub(0, 'unknown'), sub(0, 'unknown')])).toEqual({ r: 0, state: 'unknown' });
    expect(aggregate([])).toEqual({ r: 0, state: 'unknown' });
  });
  it('one weak step among steady ones -> watch', () => {
    const r = aggregate([...Array(5).fill(sub(0.95, 'steady')), sub(0.5, 'review')]);
    expect(r.state).toBe('watch');
    expect(r.r).toBeCloseTo((0.95 * 5 + 0.5) / 6, 10);
  });
  it('all steady -> steady; low mean -> review; mid mean -> watch', () => {
    expect(aggregate([sub(0.9, 'steady'), sub(0.95, 'steady')]).state).toBe('steady');
    expect(aggregate([sub(0.5, 'review'), sub(0.6, 'review')]).state).toBe('review');
    expect(aggregate([sub(0.8, 'watch'), sub(0.78, 'watch')]).state).toBe('watch');
    // a half-studied flow is watch, not review: unreviewed steps don't drag the mean to 0
    expect(aggregate([sub(0.95, 'steady'), sub(0.92, 'steady'), sub(0, 'unknown')])).toEqual({ r: 0.935, state: 'watch' });
  });
  it('unreviewed subs are left out of the mean but keep the card at watch', () => {
    expect(aggregate([sub(0.95, 'steady'), sub(0, 'unknown')])).toEqual({ r: 0.95, state: 'watch' });
  });
});

describe('property: due never precedes the review time', () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  it('random grade sequences over random gaps', () => {
    const rand = rng(42);
    for (let run = 0; run < 200; run++) {
      let m: FsrsMemory | null = null;
      let now = t0;
      for (let i = 0; i < 25; i++) {
        now = new Date(now.getTime() + Math.floor(rand() * 90 * DAY));
        const g = grades[Math.floor(rand() * 4)]!;
        m = schedule(m, g, now);
        expect(m.due.getTime()).toBeGreaterThanOrEqual(now.getTime());
        expect(m.reps).toBe(i + 1);
        expect(m.stability).toBeGreaterThan(0);
        const r = retrievability(m, now);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });
});
