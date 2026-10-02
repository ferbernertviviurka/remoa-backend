/** HTML (Anki fields) -> plain text. Output is never HTML: tags are stripped, entities decoded once. */

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…',
  deg: '°', plusmn: '±', micro: 'µ', times: '×', rarr: '→', larr: '←', uarr: '↑', darr: '↓', alpha: 'α', beta: 'β',
};

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp).replace(' ', ' ') : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

/**
 * `open … first close after it` -> f(inner). Linear: lazy regexes like /<!--[\s\S]*?-->/ go O(n²)-O(n³) on
 * fields full of openers without a closer (QA F06: 12 KB of `{{c1::` took 15 s and blocks the event loop).
 */
function replaceBlocks(s: string, open: RegExp, close: RegExp, f: (inner: string, opener: RegExpExecArray) => string): string {
  let out = '', i = 0;
  open.lastIndex = 0;
  for (let m; (m = open.exec(s)); ) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(s);
    if (!c) break; // no closer after this opener -> none after later ones either
    out += s.slice(i, m.index) + f(s.slice(open.lastIndex, c.index), m);
    i = open.lastIndex = c.index + c[0].length;
  }
  return out + s.slice(i);
}

/** Cloze Overlapping add-on wrappers: `[[r::text]]` / `[[text]]` -> `text`. */
const unwrapOverlapping = (s: string): string => replaceBlocks(s, /\[\[/g, /\]\]/g, (t) => t.replace(/^[^\]:]*::/, ''));

/** Cloze markup -> `hide(answer, hint)`; image-occlusion shapes are dropped. */
export const mapCloze = (html: string, f: (answer: string, hint: string | undefined) => string): string =>
  replaceBlocks(html, /\{\{c\d+::/g, /\}\}/g, (t) => {
    if (t.startsWith('image-occlusion:')) return '';
    const k = t.indexOf('::');
    return k < 0 ? f(t, undefined) : f(t.slice(0, k), t.slice(k + 2));
  });

export function htmlToText(html: string): string {
  const s = replaceBlocks(replaceBlocks(replaceBlocks(html, /<!--/g, /-->/g, () => ''), /<style\b/gi, /<\/style>/gi, () => ''), /<script\b/gi, /<\/script>/gi, () => '')
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/\[sound:[^[\]]*\]/g, '');
  return unwrapOverlapping(decodeEntities(s))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Private-use sentinels carry structure through entity decoding / `*` neutralizing; stripped from input first.
const MARK = '[\uE000-\uE007]';
const BOLD = '\uE000', ITAL = '\uE001', CODE = '\uE002', LK_OPEN = '\uE003', LK_URL = '\uE004', LK_END = '\uE005', CELL = '\uE006', SOFT = '\uE007';
const EMPH = new RegExp(`[${BOLD}${ITAL}${CODE}]`, 'g');
const safeUrl = (raw: string): string | null => {
  const u = decodeEntities(raw).trim();
  return /^https?:\/\/[^\s\u0000-\u001f]+$/i.test(u) ? u.replace(/[()<>"[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : null;
};

/**
 * HTML (Anki fields) -> the simple markdown the card body renders (bold, italic, lists, http(s) links; web `markdown.tsx`).
 * Never emits HTML. Literal `*` becomes `∗` (the renderer has no escapes); `_` is not markdown there, so it stays.
 */
export function htmlToMd(html: string): string {
  const urls: string[] = [];
  const clean = replaceBlocks(replaceBlocks(replaceBlocks(html.replace(new RegExp(MARK, 'g'), ''), /<!--/g, /-->/g, () => ''), /<style\b/gi, /<\/style>/gi, () => ''), /<script\b/gi, /<\/script>/gi, () => '')
    .replace(/\[sound:[^[\]]*\]/g, '');
  const linked = replaceBlocks(clean, /<a\b[^<>]*>/gi, /<\/a>/gi, (inner, o) => {
    const h = /\bhref\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s<>]+))/i.exec(o[0]);
    const url = h ? safeUrl(h[1] ?? h[2] ?? h[3] ?? '') : null;
    return url === null ? inner : `${LK_OPEN}${inner}${LK_URL}${urls.push(url) - 1}${LK_END}`;
  });
  const emph: Array<[string, boolean]> = []; // [mark, emitted]; only the outermost emphasis is emitted (the renderer cannot nest)
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let active = false;
  const withTags = linked.replace(/<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/gi, (_m, close: string, name: string) => {
    const t = name.toLowerCase();
    switch (t) {
      case 'b': case 'strong': case 'i': case 'em': case 'code': {
        const mark = t === 'code' ? CODE : t === 'b' || t === 'strong' ? BOLD : ITAL;
        if (!close) {
          emph.push([mark, !active]);
          active = true;
          return active && emph.at(-1)![1] ? mark : '';
        }
        const at = emph.findLastIndex((e) => e[0] === mark);
        if (at < 0) return '';
        const [, emitted] = emph.splice(at, 1)[0]!;
        if (emitted) active = false;
        return emitted ? mark : '';
      }
      case 'br': case 'hr': return '\n';
      case 'ul': case 'ol':
        if (close) lists.pop();
        else lists.push({ ordered: t === 'ol', n: 0 });
        return SOFT;
      case 'li': {
        if (close) return SOFT;
        const l = lists.at(-1);
        if (l) l.n++;
        return `${SOFT}${l?.ordered ? `${l.n}. ` : '- '}`;
      }
      case 'td': case 'th': return close ? CELL : '';
      case 'div': case 'p': case 'tr': case 'table': case 'blockquote': case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return SOFT;
      default: return '';
    }
  });
  let out = unwrapOverlapping(decodeEntities(withTags.replace(/<[^<>]*>/g, '')))
    .replace(/\*/g, '∗')
    .replace(/\n?\uE007+/g, '\n')
    .replace(/\uE006[ \t]*(?=\n|$)/g, '')
    .replace(/\uE006/g, ' · ')
    .replace(/([\uE000-\uE002])(\s*)\1/g, '$2');
  // an emphasis left open in a line (e.g. closed in a later div) would print raw markers: drop unpaired ones per line
  out = out.split('\n').map((line) => {
    for (const m of [BOLD, ITAL, CODE]) if (line.split(m).length % 2 === 0) line = line.replaceAll(m, '');
    return line;
  }).join('\n');
  out = out.replace(new RegExp(`${LK_OPEN}([^${LK_OPEN}-${LK_END}]*)${LK_URL}(\\d+)${LK_END}`, 'g'), (_m, text: string, i: string) => {
    const label = text.replace(EMPH, '').replace(/\s+/g, ' ').replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')')).trim();
    return label ? `[${label}](${urls[Number(i)]})` : '';
  });
  return out
    .replace(new RegExp(`[${LK_OPEN}-${LK_END}]`, 'g'), '')
    .replaceAll(BOLD, '**').replaceAll(ITAL, '*').replaceAll(CODE, '`')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `<img src>` file names in order (entities decoded, external URLs skipped, no duplicates). */
export function imgSources(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^<>]*?\bsrc\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s<>]+))/gi)) {
    const src = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (src && !/^(https?:|data:|\/\/)/i.test(src) && !out.includes(src)) out.push(src);
  }
  return out;
}
