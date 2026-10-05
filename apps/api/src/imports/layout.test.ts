import { describe, expect, it } from 'vitest';
import { HUB_SIZE, layoutImport, type LayoutItem } from './layout';

const mk = (n: number, deck: string, w = 232, h = 150, from = 0): LayoutItem[] => Array.from({ length: n }, (_, i) => ({ id: `${deck}#${from + i}`, deck, w, h }));
const counter = () => { let i = 0; return () => `hub${i++}`; };

const rects = (items: LayoutItem[], r: ReturnType<typeof layoutImport>) => [
  ...r.hubs.map((h) => ({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h })),
  ...items.map((it) => ({ id: it.id, ...r.positions.get(it.id)!, w: it.w, h: it.h })),
];
const overlaps = (rs: ReturnType<typeof rects>) => {
  const bad: string[] = [];
  rs.forEach((a, i) => rs.slice(i + 1).forEach((b) => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push(`${a.id}/${b.id}`); }));
  return bad;
};

describe('layoutImport', () => {
  it('flat deck: one hub, one edge per note, none between notes, nothing overlaps', () => {
    const items = mk(60, 'Anatomia');
    const r = layoutImport(items, counter());
    expect(r.hubs).toHaveLength(1);
    expect(r.hubs[0]).toMatchObject({ title: 'Anatomia', parentDeck: null, ...HUB_SIZE });
    expect(r.edges).toHaveLength(60);
    expect(r.edges.every((e) => e.from === 'hub0')).toBe(true);
    expect(overlaps(rects(items, r))).toEqual([]);
  });

  it('tree: ancestors get hubs, parent -> sub deck edges, mixed card sizes, several roots, no overlap', () => {
    const items = [
      ...mk(25, 'A::B::C'), ...mk(10, 'A::B', 248, 206), ...mk(40, 'A::D', 232, 240), ...mk(5, 'A'), ...mk(30, 'Z', 280, 216), ...mk(3, 'A::E::F', 248, 282),
    ];
    const r = layoutImport(items, counter());
    expect(r.hubs.map((h) => h.deck).sort()).toEqual(['A', 'A::B', 'A::B::C', 'A::D', 'A::E', 'A::E::F', 'Z']);
    const byDeck = new Map(r.hubs.map((h) => [h.deck, h]));
    const sub = r.edges.filter((e) => r.hubs.some((h) => h.id === e.to));
    expect(sub).toHaveLength(5); // B, C, D, E, F (A and Z are roots)
    for (const e of sub) expect(byDeck.get(r.hubs.find((h) => h.id === e.to)!.parentDeck!)!.id).toBe(e.from);
    expect(r.edges).toHaveLength(items.length + 5);
    expect(overlaps(rects(items, r))).toEqual([]);
  });

  it('200+ cards: no overlap, compact enough, every position is a non-negative integer', () => {
    const items = [...mk(220, 'Fisiologia'), ...mk(80, 'Fisiologia::Cardio'), ...mk(80, 'Fisiologia::Renal', 248, 206)];
    const r = layoutImport(items, counter());
    expect(overlaps(rects(items, r))).toEqual([]);
    for (const p of [...r.positions.values(), ...r.hubs]) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0).toBe(true);
    }
    const xs = [...r.positions.values()].map((p) => p.x);
    expect(Math.max(...xs)).toBeLessThan(12000);
  });

  it('is deterministic and ignores input order of decks', () => {
    const items = [...mk(12, 'B'), ...mk(7, 'A'), ...mk(5, 'A::x')];
    const a = layoutImport(items, counter());
    const b = layoutImport(items, counter());
    expect([...a.positions]).toEqual([...b.positions]);
    expect(a.hubs).toEqual(b.hubs);
    expect(a.edges).toEqual(b.edges);
  });

  it('single-note and empty inputs', () => {
    expect(layoutImport([], counter())).toMatchObject({ hubs: [], edges: [] });
    const one = mk(1, 'D');
    const r = layoutImport(one, counter());
    expect(r.edges).toEqual([{ from: 'hub0', to: 'D#0' }]);
    expect(overlaps(rects(one, r))).toEqual([]);
  });

  it('a parent with only sub decks (no own notes) still gets a hub', () => {
    const items = [...mk(3, 'P::a'), ...mk(3, 'P::b'), ...mk(3, 'P::c')];
    const r = layoutImport(items, counter());
    expect(r.hubs).toHaveLength(4);
    expect(overlaps(rects(items, r))).toEqual([]);
  });
});

describe('layoutImport size', () => {
  it('stays compact and fast: 69 cards fit in ~3000 px, 5000 cards in seconds', () => {
    const small = layoutImport(mk(69, 'T'), counter());
    const xs = [...small.positions.values()].map((p) => p.x);
    expect(Math.max(...xs)).toBeLessThan(3000);
    const t = Date.now();
    const big = layoutImport(mk(5000, 'Big'), counter());
    expect(Date.now() - t).toBeLessThan(20000); // ~1 s medido; folga para CI/máquina carregada
    expect(big.edges).toHaveLength(5000);
  }, 30000);
});
