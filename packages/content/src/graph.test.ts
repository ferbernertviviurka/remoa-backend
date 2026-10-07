import { describe, expect, it } from 'vitest';
import { topoOrder } from './graph';

describe('topoOrder', () => {
  it('orders prerequisites first', () => {
    const r = topoOrder([{ id: 'c', deps: ['a', 'b'] }, { id: 'b', deps: ['a'] }, { id: 'a', deps: [] }]);
    expect(r).toEqual({ ok: true, order: ['a', 'b', 'c'] });
  });

  it('returns a closed cycle path', () => {
    const r = topoOrder([{ id: 'a', deps: [] }, { id: 'b', deps: ['a', 'd'] }, { id: 'c', deps: ['b'] }, { id: 'd', deps: ['c'] }, { id: 'e', deps: ['d'] }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cycle[0]).toBe(r.cycle.at(-1));
      expect(new Set(r.cycle)).toEqual(new Set(['b', 'c', 'd']));
    }
  });

  it('finds a self loop', () => {
    expect(topoOrder([{ id: 'a', deps: ['a'] }])).toEqual({ ok: false, cycle: ['a', 'a'] });
  });
});
