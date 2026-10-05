/**
 * F06/G10 (D-332/D-333): pure radial layout for an imported Anki package. One hub per deck (and per ancestor path), hub -> note
 * edges, parent hub -> sub deck edges; no edge between notes. Notes of a deck sit on concentric rings around its hub (each ring as
 * tight as the real card rectangles allow); sub decks are clusters (bounding circles) spread on a ring around the parent, so
 * rectangles of different clusters can never touch. Deterministic: same input, same output (ids come from `mkId`).
 * ponytail: edges are straight lines, so an outer-ring edge passes behind inner-ring cards; fine at ~200 cards, add edge routing if it bothers.
 */
export type LayoutItem = { id: string; deck: string; w: number; h: number };
export type LayoutHub = { id: string; deck: string; title: string; parentDeck: string | null; x: number; y: number; w: number; h: number };
export type LayoutResult = { hubs: LayoutHub[]; positions: Map<string, { x: number; y: number }>; edges: { from: string; to: string }[] };

export const HUB_SIZE = { w: 248, h: 176 } as const; // = note card default (@remoa/ui nodeSize)
const ASPECT = 1.7; // width/height of the cluster search path (ellipse)
const GAP = 28; // free space between two cards
const CLUSTER_GAP = 64; // between two sub deck clusters
const STEP = 8; // radius search step
const SEP = '::';

type P = { x: number; y: number };
type Node = { deck: string; leaves: LayoutItem[]; kids: Node[]; r: number; x: number; y: number; rel: Map<string, P> };

const clash = (a: P, b: P, w: number, h: number) => Math.abs(a.x - b.x) < w + GAP && Math.abs(a.y - b.y) < h + GAP; // same-size rects (centres)
const hubClash = (p: P, w: number, h: number) => Math.abs(p.x) < (w + HUB_SIZE.w) / 2 + GAP && Math.abs(p.y) < (h + HUB_SIZE.h) / 2 + GAP;
const at = (R: number, n: number, k: number): P => ({ x: R * Math.cos(-Math.PI / 2 + (2 * Math.PI * k) / n), y: R * Math.sin(-Math.PI / 2 + (2 * Math.PI * k) / n) });

/** Own cards on rings around the hub (centre 0,0, every card treated as the deck's biggest one); sets rel + the cluster radius. */
function pack(n: Node) {
  const w = n.leaves.reduce((m, l) => Math.max(m, l.w), 0), h = n.leaves.reduce((m, l) => Math.max(m, l.h), 0);
  let outer = Math.hypot(HUB_SIZE.w, HUB_SIZE.h) / 2;
  let R = 0, i = 0;
  let before: P[][] = []; // the last two rings
  while (i < n.leaves.length) {
    const left = n.leaves.length - i;
    for (R += STEP; ; R += STEP) {
      let cnt = Math.min(left, Math.max(1, Math.floor((2 * Math.PI * R) / Math.min(w, h))));
      while (cnt > 1 && Array.from({ length: cnt }, (_, k) => k).some((k) => clash(at(R, cnt, k), at(R, cnt, (k + 1) % cnt), w, h))) cnt--; // fewer cards until neighbours clear
      const ring = Array.from({ length: cnt }, (_, k) => at(R, cnt, k));
      if (ring.some((p) => hubClash(p, w, h) || before.some((rg) => rg.some((q) => clash(p, q, w, h))))) continue;
      ring.forEach((p, k) => n.rel.set(n.leaves[i + k]!.id, p));
      i += cnt;
      before = [...before.slice(-1), ring];
      outer = Math.max(outer, R + Math.hypot(w, h) / 2); // farthest rect corner
      break;
    }
  }
  if (!n.kids.length) return void (n.r = outer);
  // sub deck clusters (circles): biggest first, each at the closest free spot to the hub (greedy circle packing; disjoint circles = disjoint cards)
  const placed: { x: number; y: number; r: number }[] = [{ x: 0, y: 0, r: outer }];
  for (const k of [...n.kids].sort((p, q) => q.r - p.r || (p.deck < q.deck ? -1 : 1))) {
    const r = k.r + CLUSTER_GAP / 2;
    search: for (let d = outer; ; d += 24) {
      const steps = Math.max(12, Math.ceil((2 * Math.PI * d) / 60));
      for (let j = 0; j < steps; j++) {
        const a = -Math.PI / 2 + (2 * Math.PI * j) / steps;
        const p = { x: ASPECT * d * Math.cos(a), y: d * Math.sin(a) }; // ellipse: the editor viewport is landscape, so "Ajustar" shows the whole map at a higher zoom
        if (placed.every((c) => Math.hypot(c.x - p.x, c.y - p.y) >= c.r + r)) {
          [k.x, k.y] = [p.x, p.y];
          placed.push({ ...p, r });
          break search;
        }
      }
    }
  }
  n.r = Math.max(...placed.map((c) => Math.hypot(c.x, c.y) + c.r));
}

export function layoutImport(items: LayoutItem[], mkId: () => string = () => crypto.randomUUID()): LayoutResult {
  const nodes = new Map<string, Node>();
  const get = (deck: string): Node => {
    let n = nodes.get(deck);
    if (!n) {
      n = { deck, leaves: [], kids: [], r: 0, x: 0, y: 0, rel: new Map() };
      nodes.set(deck, n);
      const up = deck.lastIndexOf(SEP);
      if (up > 0) get(deck.slice(0, up)).kids.push(n);
    }
    return n;
  };
  for (const it of items) get(it.deck).leaves.push(it);
  const roots = [...nodes.values()].filter((n) => !n.deck.includes(SEP));
  const post = (n: Node) => { n.kids.sort((a, b) => (a.deck < b.deck ? -1 : 1)); n.kids.forEach(post); pack(n); };
  roots.sort((a, b) => (a.deck < b.deck ? -1 : 1)).forEach(post);

  const hubs: LayoutHub[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const edges: LayoutResult['edges'] = [];
  const place = (n: Node, cx: number, cy: number, parent: LayoutHub | null) => {
    const hub: LayoutHub = { id: mkId(), deck: n.deck, title: n.deck.split(SEP).pop()!, parentDeck: parent?.deck ?? null, x: cx - HUB_SIZE.w / 2, y: cy - HUB_SIZE.h / 2, ...HUB_SIZE };
    hubs.push(hub);
    if (parent) edges.push({ from: parent.id, to: hub.id });
    for (const l of n.leaves) {
      const p = n.rel.get(l.id)!;
      positions.set(l.id, { x: cx + p.x - l.w / 2, y: cy + p.y - l.h / 2 });
      edges.push({ from: hub.id, to: l.id });
    }
    for (const k of n.kids) place(k, cx + k.x, cy + k.y, hub);
  };
  // several root decks: clusters side by side
  let cx = 0;
  roots.forEach((r, i) => {
    cx += i ? roots[i - 1]!.r + r.r + GAP : 0;
    place(r, cx, 0, null);
  });
  // top-left at (0, 0), whole numbers (cards.x/y are integers)
  const all = [...hubs, ...[...positions.values()]];
  const minX = Math.min(...all.map((p) => p.x)), minY = Math.min(...all.map((p) => p.y));
  for (const p of all) { p.x = Math.round(p.x - minX); p.y = Math.round(p.y - minY); }
  return { hubs, positions, edges };
}
