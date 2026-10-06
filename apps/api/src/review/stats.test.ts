// G21 FR-23 (D-1030): the pure parts of map_stats. No database.
import { describe, expect, it } from 'vitest';
import type { FsrsMemory } from '@remoa/contracts';
import { schedule } from '@remoa/fsrs';
import { cardState, stateKey, type CardRow, type StateRow } from './queue';
import { boardStat, nextChange } from './stats';

const DAY = 86_400_000;
const t0 = new Date('2026-06-10T15:00:00Z');
const endMs = Date.parse('2026-06-11T07:00:00Z'); // 04:00 in São Paulo
const card = (id: string, o: Partial<CardRow> = {}): CardRow => ({
  id, boardId: 'b', area: 'CM', type: 'concept', order: 0, boardMs: 0, own: true, subs: [''], x: 0, y: 0, suspended: false, ...o,
});
const learned = (days: number, grade: 'good' | 'easy' = 'good'): FsrsMemory => {
  let m = schedule(null, grade, new Date(t0.getTime() - days * DAY));
  m = schedule(m, grade, new Date(m.due.getTime()));
  return m;
};
const states = (rows: [string, string, FsrsMemory][]) =>
  new Map<string, StateRow>(rows.map(([cardId, subId, m]) => [stateKey(cardId, subId), { ...m, cardId, subId, createdMs: 0 }]));

describe('boardStat', () => {
  it('counts card-level states, notes apart, due like the queue (suspended never due), reviewed and the recall sum', () => {
    const due = learned(400);
    const fresh = schedule(null, 'easy', new Date(t0.getTime() - 60_000));
    const st = states([['c1', '', due], ['c2', '', fresh], ['c4', '', due], ['f', 's1', fresh]]);
    const cards = [card('c1'), card('c2'), card('c3'), card('c4', { suspended: true }), card('n', { type: 'note', subs: [] }), card('f', { type: 'flow', subs: ['s1', 's2'] })];
    const s = boardStat(cards, st, t0, endMs, 7);
    expect(s).toMatchObject({ cards: 5, notes: 1, edges: 7, due: 1 }); // c1 (c4 is suspended; the flow's s1 is not due)
    expect(s.states.unknown).toBe(1); // c3
    expect(s.states.review + s.states.watch + s.states.steady + s.states.unknown).toBe(5);
    expect(s.reviewed).toBe(4);
    const r = ['c1', 'c2', 'c4', 'f'].map((id) => cardState(cards.find((c) => c.id === id)!, st, t0).r).reduce((a, b) => a + b, 0);
    expect(s.rSum).toBeCloseTo(r, 7);
  });

  it('empty board is zeros', () => {
    expect(boardStat([], new Map(), t0, endMs, 0)).toEqual({ cards: 0, notes: 0, edges: 0, states: { review: 0, watch: 0, steady: 0, unknown: 0 }, due: 0, reviewed: 0, rSum: 0 });
  });
});

describe('nextChange', () => {
  const states1 = (m: FsrsMemory) => states([['c1', '', m]]);
  const stateAt = (st: Map<string, StateRow>, t: number) => cardState(card('c1'), st, new Date(t)).state;

  it('nothing studied -> the end of the study day', () => {
    expect(nextChange([card('c1')], new Map(), t0, endMs)).toBe(endMs);
  });

  it('finds the first state change within 1 min, and nothing changes before it', () => {
    // a card that falls from steady to watch some hours from now: search the age that puts the change inside the window
    let found = false;
    for (let h = 1; h < 24 * 60 && !found; h += 1) {
      const m = learned(h / 24);
      const st = states1(m);
      const at = nextChange([card('c1')], st, t0, endMs);
      if (at >= endMs) continue;
      found = true;
      const before = stateAt(st, t0.getTime());
      expect(stateAt(st, at)).not.toBe(before);
      expect(stateAt(st, at - 60_001)).toBe(before);
    }
    expect(found).toBe(true);
  });

  it('a due date inside the window is a change (review)', () => {
    const m: FsrsMemory = { stability: 100, difficulty: 5, due: new Date(t0.getTime() + 3 * 3_600_000), reps: 3, lapses: 0, lastReview: new Date(t0.getTime() - 3_600_000), state: 'review', learningSteps: 0, scheduledDays: 1 };
    const st = states1(m);
    expect(stateAt(st, t0.getTime())).toBe('steady');
    const at = nextChange([card('c1')], st, t0, endMs);
    expect(at).toBeGreaterThan(m.due.getTime() - 1);
    expect(at - m.due.getTime()).toBeLessThanOrEqual(60_000);
    expect(stateAt(st, at)).toBe('review');
  });
});
