import { describe, expect, it } from 'vitest';
import { activityLevel, queueFilterSchema, reviewHubSchema } from './index';
import { reviewHubFixture } from './mocks/review-hub';

describe('ReviewHub contract (G15)', () => {
  it.each(['active', 'done', 'empty', 'no_history'] as const)('mock "%s" matches the schema', (status) => {
    expect(reviewHubSchema.parse(reviewHubFixture(status)).status).toBe(status);
  });
  it('active mock is the canvas queue: 12 cards for Free (7 due + 5 new)', () => {
    const q = reviewHubFixture().queue;
    expect(q).toMatchObject({ counts: { due: 7, new: 5, weak: 11 }, defaultCount: 12, newLimit: 10 });
  });
  it('activity levels', () => {
    expect([0, 1, 5, 6, 10, 11, 20, 21].map(activityLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
  it('queue filter is strict and non-empty', () => {
    expect(queueFilterSchema.safeParse({ reasons: ['due'], area: 'CM' }).success).toBe(true);
    expect(queueFilterSchema.safeParse({ reasons: [] }).success).toBe(false);
    expect(queueFilterSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
