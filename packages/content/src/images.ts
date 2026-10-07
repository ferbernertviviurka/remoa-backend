// FR-16/17/18 `content:images`: safe original SVG (or licensed raster) with credit, alt and occlusion labels; WebP in F02's variants.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetLicense, CardFile } from '@remoa/contracts';
import sharp from 'sharp';
import { erro, type Bundle, type Issue } from './load';

/** CREDITOS.md license -> assets.license. `cc0` waits for P-650 (not in the asset_license enum). */
export const CREDIT_LICENSES: Record<string, AssetLicense> = { original: 'own', cc_by: 'cc_by', openstax: 'openstax', servier: 'servier' };
/** F02 variants (apps/api uploads.ts): same names and widths. */
export const VARIANTS = { w800: 800, w1600: 1600 } as const;

type ImageCard = Extract<CardFile, { tipo: 'imagem' }>;

/** Problems that make an SVG unsafe or unusable for occlusion (empty = ok). Regex on the source: we never render before this passes. */
export function checkSvg(svg: string): string[] {
  const out: string[] = [];
  if (/<script\b/i.test(svg)) out.push('contém <script>');
  if (/<foreignObject\b/i.test(svg)) out.push('contém <foreignObject>');
  if (/<!(DOCTYPE|ENTITY)\b/i.test(svg)) out.push('contém DOCTYPE/ENTITY');
  if (/\son[a-z]+\s*=/i.test(svg)) out.push('contém atributo de evento (on...)');
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) if (!m[1]!.trim().startsWith('#')) out.push(`href externo: ${m[1]!.slice(0, 60)}`);
  if (/url\(\s*['"]?\s*(?!#)/i.test(svg) || /@import/i.test(svg)) out.push('recurso externo em estilo (url()/@import)');
  if (!/<svg\b[^>]*\bviewBox\s*=/i.test(svg)) out.push('sem viewBox');
  if (!/<text\b/i.test(svg)) out.push('sem rótulo de texto');
  return out;
}

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Occlusion box for each label, from the `<text>` whose content equals it, normalized to the viewBox (0..1).
 * ponytail: width is estimated (0.6 em per character) and transforms on parent groups are ignored; if masks drift, add an
 * explicit `<rect data-mascara="...">` per label and read that instead.
 */
export function maskPolygons(svg: string, labels: string[]): { label: string; polygon: { x: number; y: number }[] | null }[] {
  const vb = (svg.match(/<svg\b[^>]*\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').split(/[\s,]+/).map(Number);
  const [minX = 0, minY = 0, w = 1, h = 1] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [];
  const texts = [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)].map((m) => ({ attrs: m[1]!, text: plain(m[2]!) }));
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
  return labels.map((label) => {
    const t = texts.find((x) => x.text.toLowerCase() === label.trim().toLowerCase());
    if (!t) return { label, polygon: null };
    const fs = Number(attr(t.attrs, 'font-size') ?? t.attrs.match(/font-size\s*:\s*([\d.]+)/i)?.[1] ?? 16);
    const x = Number(attr(t.attrs, 'x') ?? 0);
    const y = Number(attr(t.attrs, 'y') ?? 0);
    const width = 0.6 * fs * t.text.length + 4;
    const anchor = attr(t.attrs, 'text-anchor') ?? 'start';
    const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x - 2;
    const [y0, y1] = [y - fs - 2, y + 0.3 * fs + 2];
    const [l, r, top, bot] = [clamp((x0 - minX) / w), clamp((x0 + width - minX) / w), clamp((y0 - minY) / h), clamp((y1 - minY) / h)];
    return { label, polygon: [{ x: l, y: top }, { x: r, y: top }, { x: r, y: bot }, { x: l, y: bot }] };
  });
}

/** WebP variants as F02 stores them; SVG is rasterized at high density so w1600 is sharp. */
export async function toWebp(bytes: Buffer, svg: boolean) {
  const variants = {} as Record<keyof typeof VARIANTS, Buffer>;
  let size = { width: 1, height: 1 };
  for (const [name, width] of Object.entries(VARIANTS) as [keyof typeof VARIANTS, number][]) {
    const { data, info } = await sharp(bytes, svg ? { density: 300 } : {})
      .rotate()
      .resize({ width, withoutEnlargement: !svg })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    variants[name] = data;
    if (name === 'w1600') size = { width: info.width, height: info.height };
  }
  return { variants, ...size };
}

const imageCards = (b: Bundle) => (b.map?.cards ?? []).filter((c): c is ImageCard => c.tipo === 'imagem');
const fileOf = (c: ImageCard) => c.imagem.arquivo.replace(/^imagens\//, '');

/** FR-16/17/18: every file credited with an accepted license, used by a card with alt text; SVG safe and with its mask labels. */
export function checkImages(b: Bundle): Issue[] {
  const out: Issue[] = [];
  const cards = imageCards(b);
  if (b.images.length && !b.credits) out.push(erro('imagens/CREDITOS.md', 'arquivo ausente (FR-16)'));
  for (const f of b.images) {
    const where = `imagens/${f}`;
    const credit = b.credits?.get(f);
    if (b.credits && !credit) out.push(erro(where, 'sem linha em CREDITOS.md'));
    if (credit) {
      const lic = CREDIT_LICENSES[credit.licenca];
      if (credit.licenca === 'cc0') out.push(erro(where, 'licença cc0 aguarda P-650 (não existe em assets.license)'));
      else if (!lic) out.push(erro(where, `licença "${credit.licenca}" não aceita (original, cc_by, openstax, servier)`));
      if (credit.licenca !== 'original' && !credit.credito) out.push(erro(where, 'crédito obrigatório fora de licença original'));
      for (const c of cards.filter((x) => fileOf(x) === f))
        if (lic && c.imagem.licenca !== lic) out.push(erro(`cards[${c.id}].imagem.licenca`, `${c.imagem.licenca} no card, ${credit.licenca} em CREDITOS.md`));
    }
    const users = cards.filter((c) => fileOf(c) === f);
    if (!users.length) out.push(erro(where, 'imagem sem card (o texto alternativo vem do card, FR-18)'));
    if (!f.endsWith('.svg')) {
      if (users.some((c) => c.imagem.mascaras.length)) out.push(erro(where, 'máscaras só em SVG (os rótulos vêm do <text>)'));
      continue;
    }
    const svg = readFileSync(join(b.dir, 'imagens', f), 'utf8');
    const bad = checkSvg(svg);
    out.push(...bad.map((m) => erro(where, m)));
    if (bad.length) continue;
    for (const c of users)
      for (const m of maskPolygons(svg, c.imagem.mascaras.map((x) => x.rotulo)))
        if (!m.polygon) out.push(erro(`cards[${c.id}].imagem.mascaras`, `rótulo "${m.label}" não está num <text> de ${f}`));
  }
  return out; // alt text: required by cardFileSchema (FR-18)
}
