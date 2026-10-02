import type { MaskDraft } from '@remoa/contracts';
import { imgSources } from './html';

type Point = { x: number; y: number };
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const box = (l: number, t: number, w: number, h: number): Point[] | null =>
  [l, t, w, h].every(Number.isFinite) && w > 0 && h > 0
    ? [
        { x: clamp(l), y: clamp(t) },
        { x: clamp(l + w), y: clamp(t) },
        { x: clamp(l + w), y: clamp(t + h) },
        { x: clamp(l), y: clamp(t + h) },
      ]
    : null;

const toMasks = (polys: Array<Point[] | null>): MaskDraft[] =>
  polys
    .filter((p): p is Point[] => p !== null && p.length >= 3 && p.length <= 64)
    .map((polygon, i) => ({ polygon, label: `Máscara ${i + 1}` }));

/** Native Anki 23.10+: `{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}` (all 0..1). */
export function nativeMasks(field: string): MaskDraft[] {
  const polys: Array<Point[] | null> = [];
  for (const m of field.matchAll(/\{\{c\d+::image-occlusion:(rect|ellipse|polygon):([^{}]*)\}\}/g)) {
    const p: Record<string, string> = {};
    for (const kv of (m[2] ?? '').split(':')) {
      const i = kv.indexOf('=');
      if (i > 0) p[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const n = (k: string) => Number(p[k] ?? NaN);
    if (m[1] === 'rect') polys.push(box(n('left'), n('top'), n('width'), n('height')));
    else if (m[1] === 'ellipse') polys.push(box(n('left'), n('top'), n('rx') * 2, n('ry') * 2));
    else {
      const pts = (p.points ?? '').trim().split(/\s+/).map((s) => s.split(',').map(Number));
      polys.push(pts.every((q) => q.length === 2 && q.every(Number.isFinite)) ? pts.map(([x, y]) => ({ x: clamp(x!), y: clamp(y!) })) : null);
    }
  }
  return toMasks(polys);
}

const attrs = (tag: string): Record<string, string> => {
  const a: Record<string, string> = {};
  for (const m of tag.matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*"([^"]*)"/g)) a[m[1]!] = m[2]!;
  return a;
};

const nums = (s: string): number[] => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** `<path d>` made only of M/L/H/V/Z (absolute or relative) -> first sub-path as a polygon; null if anything else. */
function pathPoints(d: string): Point[] | null {
  const pts: Point[] = [];
  let x = 0, y = 0, started = false;
  for (const m of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const c = m[1]!;
    const n = nums(m[2]!);
    const rel = c === c.toLowerCase();
    const C = c.toUpperCase();
    if (C === 'Z') continue;
    if (!'MLHV'.includes(C) || n.some((v) => !Number.isFinite(v)) || n.length === 0) return null;
    if (C === 'M' && started) break; // only the first sub-path
    if (C === 'H') for (const v of n) { x = rel ? x + v : v; pts.push({ x, y }); }
    else if (C === 'V') for (const v of n) { y = rel ? y + v : v; pts.push({ x, y }); }
    else {
      if (n.length % 2) return null;
      for (let i = 0; i < n.length; i += 2) {
        x = rel && !(C === 'M' && !started && i === 0) ? x + n[i]! : n[i]!;
        y = rel && !(C === 'M' && !started && i === 0) ? y + n[i + 1]! : n[i + 1]!;
        pts.push({ x, y });
      }
      if (C === 'M') started = true;
    }
  }
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last && last.x === pts[0]!.x && last.y === pts[0]!.y) pts.pop();
  return pts.length >= 3 ? pts : null;
}

/** IOE's "active" (asked) shape in a Question Mask is filled with this colour. */
const ACTIVE = /#ff7e7e/i;

export type SvgShapes = { masks: MaskDraft[]; skipped: number };

/**
 * Image Occlusion Enhanced SVG (pixel coordinates): rect (+rx/ry), ellipse (bbox), polygon, M/L/H/V/Z path,
 * inside nested <g transform="translate(..)">. With `activeOnly`, shapes filled #ff7e7e win when present.
 */
export function svgShapes(svg: string, activeOnly = false): SvgShapes {
  const root = attrs(/<svg\b[^>]*>/i.exec(svg)?.[0] ?? '');
  const vb = (root.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  const W = parseFloat(root.width ?? '') || vb[2] || NaN;
  const H = parseFloat(root.height ?? '') || vb[3] || NaN;
  if (!(W > 0 && H > 0)) return { masks: [], skipped: 0 };
  const shapes: Array<{ poly: Point[] | null; active: boolean }> = [];
  const stack: Array<[number, number]> = [[0, 0]];
  for (const m of svg.matchAll(/<(\/?)(g|rect|ellipse|polygon|path)\b([^<>]*?)(\/?)>/gi)) {
    const tag = m[2]!.toLowerCase();
    if (tag === 'g') {
      if (m[1]) {
        if (stack.length > 1) stack.pop();
      }
      else if (!m[4]) {
        const t = /translate\(([^()]*)\)/i.exec(attrs(m[3]!).transform ?? '');
        const [tx = 0, ty = 0] = t ? nums(t[1]!) : [];
        const [px, py] = stack[stack.length - 1]!;
        stack.push([px + tx, py + ty]);
      }
      continue;
    }
    if (m[1]) continue;
    const [ox, oy] = stack[stack.length - 1]!;
    const a = attrs(m[3]!);
    const n = (k: string) => Number(a[k] ?? NaN);
    let px: Point[] | null = null;
    if (tag === 'rect') px = [{ x: (n('x') || 0) + ox, y: (n('y') || 0) + oy }, { x: (n('x') || 0) + ox + n('width'), y: (n('y') || 0) + oy }, { x: (n('x') || 0) + ox + n('width'), y: (n('y') || 0) + oy + n('height') }, { x: (n('x') || 0) + ox, y: (n('y') || 0) + oy + n('height') }];
    else if (tag === 'ellipse') px = [{ x: n('cx') - n('rx') + ox, y: n('cy') - n('ry') + oy }, { x: n('cx') + n('rx') + ox, y: n('cy') - n('ry') + oy }, { x: n('cx') + n('rx') + ox, y: n('cy') + n('ry') + oy }, { x: n('cx') - n('rx') + ox, y: n('cy') + n('ry') + oy }];
    else if (tag === 'polygon') {
      const v = nums(a.points ?? '');
      px = v.length >= 6 && v.length % 2 === 0 ? Array.from({ length: v.length / 2 }, (_, i) => ({ x: v[2 * i]! + ox, y: v[2 * i + 1]! + oy })) : null;
    } else {
      const p = pathPoints(a.d ?? '');
      px = p && p.map((q) => ({ x: q.x + ox, y: q.y + oy }));
    }
    const norm = px && px.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) ? px.map((q) => ({ x: clamp(q.x / W), y: clamp(q.y / H) })) : null;
    const okPoly = norm && norm.length >= 3 && norm.length <= 64 && new Set(norm.map((q) => `${q.x},${q.y}`)).size >= 3 ? norm : null;
    shapes.push({ poly: okPoly, active: ACTIVE.test(a.fill ?? '') });
  }
  const chosen = activeOnly && shapes.some((x) => x.active) ? shapes.filter((x) => x.active) : shapes;
  return { masks: toMasks(chosen.map((x) => x.poly)), skipped: chosen.filter((x) => !x.poly).length };
}

export const svgMasks = (svg: string, activeOnly = false): MaskDraft[] => svgShapes(svg, activeOnly).masks;

/** Masks from an IOE mask field: inline <svg> or <img src="….svg"> resolved through `readSvg`. */
export function fieldSvgMasks(field: string, readSvg: (name: string) => string | null, activeOnly = false): MaskDraft[] {
  if (/<svg\b/i.test(field)) return svgMasks(field, activeOnly);
  return imgSources(field)
    .filter((n) => /\.svg$/i.test(n))
    .flatMap((n) => {
      const s = readSvg(n);
      return s ? svgMasks(s, activeOnly) : [];
    });
}
