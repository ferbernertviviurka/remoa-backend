import { describe, expect, it } from 'vitest';
import { ENAMED_ITEMS } from './enamed';
import { parentsFirst, taxonomyFromMatrix, type MatrixRow } from './enamed-taxonomy';

const fromSeed = (): MatrixRow[] => {
  const id = (code: string) => `id:${code}`;
  return ENAMED_ITEMS.map((i) => ({ id: id(i.code), area: 'CM', code: i.code, title: i.title, parentId: i.parentCode ? id(i.parentCode) : null }));
};

describe('enamed_taxonomy from matrix_items (D-1604)', () => {
  it('maps the 2-level CM seed to area -> domain -> topic, names copied from the matrix', () => {
    const rows = taxonomyFromMatrix(fromSeed());
    const groups = ENAMED_ITEMS.filter((i) => !i.parentCode);
    expect(rows.filter((r) => r.kind === 'area')).toEqual([{ code: 'CM', kind: 'area', area: 'CM', name: 'CM', matrixRef: null, parentCode: null }]);
    expect(rows.filter((r) => r.kind === 'domain').map((r) => r.code)).toEqual(groups.map((g) => g.code));
    expect(rows.filter((r) => r.kind === 'domain').every((r) => r.parentCode === 'CM')).toBe(true);
    expect(rows.filter((r) => r.kind === 'competency')).toEqual([]);
    expect(rows.filter((r) => r.kind === 'topic')).toHaveLength(ENAMED_ITEMS.length - groups.length);
    const titles = new Set(ENAMED_ITEMS.map((i) => i.title));
    expect(rows.filter((r) => r.kind !== 'area').every((r) => titles.has(r.name))).toBe(true);
  });

  it('a middle level with children becomes competency', () => {
    const rows = taxonomyFromMatrix([
      { id: '1', area: 'CM', code: 'X', title: 'x', parentId: null },
      { id: '2', area: 'CM', code: 'X.1', title: 'y', parentId: '1' },
      { id: '3', area: 'CM', code: 'X.1.1', title: 'z', parentId: '2' },
    ]);
    expect(rows.map((r) => [r.code, r.kind, r.parentCode])).toEqual([
      ['CM', 'area', null], ['X', 'domain', 'CM'], ['X.1', 'competency', 'X'], ['X.1.1', 'topic', 'X.1'],
    ]);
  });

  it('orders parents first and rejects a missing parent', () => {
    const rows = parentsFirst(taxonomyFromMatrix(fromSeed()).reverse());
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.parentCode) expect(seen.has(r.parentCode)).toBe(true);
      seen.add(r.code);
    }
    expect(() => taxonomyFromMatrix([{ id: '2', area: 'CM', code: 'X.1', title: 'y', parentId: 'nope' }])).toThrow(/parent/);
  });
});
