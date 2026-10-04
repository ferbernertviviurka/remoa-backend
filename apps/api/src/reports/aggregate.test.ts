import { describe, expect, it } from 'vitest';
import { summarize, summarizeBuckets, type AttemptBucket, type AttemptFact } from './aggregate';

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);

describe('progress aggregate', () => {
  it('matches 1000 attempts: retention, streak and weak cards', () => {
    const attempts: AttemptFact[] = Array.from({ length: 1000 }, (_, i) => ({
      day: day((i % 30) + 1),
      grade: i % 5 === 0 ? 1 : 3,
      area: 'CM',
      matrixItemId: i % 2 === 0 ? '11111111-1111-4111-8111-111111111111' : null,
    }));
    const weak = Array.from({ length: 25 }, (_, i) => ({
      cardId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      boardId: '22222222-2222-4222-8222-222222222222',
      title: `card ${i}`,
      r: i / 40,
    }));
    const summary = summarize(attempts, weak, day(30));
    const window = attempts.filter((a) => a.day >= day(1) && a.day <= day(30));
    expect(summary.retention30d).toBeCloseTo(window.filter((a) => a.grade >= 3).length / window.length);
    expect(summary.reviewsPerDay).toHaveLength(30);
    expect(summary.reviewsPerDay.reduce((n, d) => n + d.count, 0)).toBe(window.length);
    expect(summary.weakCards).toHaveLength(20);
    expect(summary.weakCards.every((c) => c.r < 0.7)).toBe(true);
    expect(summary.streakDays).toBeGreaterThan(0);
    expect(summary.accuracy.reduce((n, a) => n + a.attempts, 0)).toBe(window.length);
    const named = summarize(
      [{ day: day(30), grade: 4, area: 'CM', matrixItemId: '11111111-1111-4111-8111-111111111111', matrixTitle: 'Sepse e choque séptico' }],
      [],
      day(30),
    );
    expect(named.accuracy[0]?.label).toBe('Sepse e choque séptico');
  });

  it('counts a streak that started before the 30-day window', () => {
    const today = '2026-02-10';
    const studied = Array.from({ length: 45 }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));
    const summary = summarize([{ day: today, grade: 4, area: 'CM', matrixItemId: null }], [], today, studied);
    expect(summary.streakDays).toBe(45);
    expect(summary.retention30d).toBe(1);
    expect(summary.reviewsPerDay.reduce((n, d) => n + d.count, 0)).toBe(1);
  });

  it('summarizes 50k attempts in under 300ms', () => {
    const attempts: AttemptFact[] = Array.from({ length: 50_000 }, (_, i) => ({
      day: day((i % 30) + 1),
      grade: i % 4 === 0 ? 1 : 4,
      area: 'CM',
      matrixItemId: null,
    }));
    const start = performance.now();
    const summary = summarize(attempts, [], day(30));
    expect(performance.now() - start).toBeLessThan(300);
    expect(summary.reviewsPerDay).toHaveLength(30);
    expect(summary.reviewsPerDay.reduce((n, d) => n + d.count, 0)).toBe(50_000);
    expect(summary.accuracy).toHaveLength(1);
    expect(summary.accuracy[0]?.attempts).toBe(50_000);
  });

  it('grouped counts match the row-by-row report', () => {
    const attempts: AttemptFact[] = Array.from({ length: 1000 }, (_, i) => ({
      day: day((i % 30) + 1),
      grade: i % 5 === 0 ? 1 : 3,
      area: 'CM',
      matrixItemId: i % 2 === 0 ? '11111111-1111-4111-8111-111111111111' : null,
      matrixTitle: i % 2 === 0 ? 'Sepse' : null,
    }));
    const grouped = new Map<string, AttemptBucket>();
    for (const a of attempts) {
      const key = `${a.day}:${a.matrixItemId ?? ''}`;
      const row = grouped.get(key) ?? { day: a.day, attempts: 0, hits: 0, area: 'CM' as const, matrixItemId: a.matrixItemId, matrixTitle: a.matrixTitle };
      row.attempts += 1;
      if (a.grade >= 3) row.hits += 1;
      grouped.set(key, row);
    }
    const today = day(30);
    expect(summarizeBuckets([...grouped.values()], [], today)).toEqual(summarize(attempts, [], today));
  });
});
