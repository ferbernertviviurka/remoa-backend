// F27 T1 (FR-6, FR-25, FR-27, FR-28, D-917/D-918): BlogDoc JSON -> HTML by allow-list. The HTML is *built* from the JSON;
// no user string is ever emitted unescaped, and only the elements/attributes below exist in the output. The input is treated as
// untrusted even though the API stores the blogDocSchema parse output: unknown nodes/marks are dropped, unsafe hrefs become text.
// Class contract = ArticleBody (D-931): rb-callout (div role=note data-variant), rb-faq / rb-faq-item (details/summary), rb-button.
import {
  calloutVariants,
  countWords,
  extractFaq,
  extractToc,
  isExternalHref,
  isSafeHref,
  readingMinutes,
  slugify,
  type BlogBlock,
  type BlogDoc,
  type BlogFaqItem,
  type BlogTocEntry,
  type CalloutVariant,
} from '@remoa/contracts';

export type ImageRef = { assetId?: string; src?: string };
export type ResolvedImage = { src: string; srcset?: string; sizes?: string; width: number; height: number };
export type RenderOptions = { image: (ref: ImageRef) => ResolvedImage | null };

/** Lead-in label of each callout (fixed by ArticleBody, D-931). */
export const CALLOUT_LABELS: Record<CalloutVariant, string> = { dica: 'Dica.', atencao: 'Atenção.', nota: 'Nota.' };

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text and attribute values (always double-quoted in the output). */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

// Runtime view of a node: never trust the TS type of something that came from a request body.
type Node = { type?: unknown; text?: unknown; content?: unknown; attrs?: Record<string, unknown> | null; marks?: unknown };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const kids = (n: Node): Node[] => (Array.isArray(n.content) ? (n.content as Node[]).filter((c) => c && typeof c === 'object') : []);
const isLevel = (v: unknown): v is 2 | 3 | 4 => v === 2 || v === 3 || v === 4;
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** href + target/rel for a safe href; null = not allowed (caller renders plain text / drops the block). */
function linkAttrs(rawHref: unknown, rel?: unknown): string | null {
  const href = str(rawHref).trim();
  if (!isSafeHref(href)) return null;
  let out = ` href="${escapeHtml(href)}"`;
  if (isExternalHref(href)) {
    const extra = rel === 'nofollow' || rel === 'sponsored' ? ` ${rel}` : '';
    out += ` target="_blank" rel="noopener noreferrer${extra}"`;
  }
  return out;
}

function renderText(n: Node): string {
  if (n.type !== 'text') return '';
  let html = escapeHtml(str(n.text));
  if (!html) return '';
  const marks = Array.isArray(n.marks) ? (n.marks as Node[]) : [];
  const has = (t: string) => marks.find((m) => m && m.type === t);
  if (has('italic')) html = `<em>${html}</em>`;
  if (has('bold')) html = `<strong>${html}</strong>`;
  const link = has('link');
  const attrs = link ? linkAttrs(link.attrs?.href, link.attrs?.rel) : null;
  return attrs ? `<a${attrs}>${html}</a>` : html;
}

const inline = (n: Node) => kids(n).map(renderText).join('');

function renderFlow(n: Node): string {
  switch (n.type) {
    case 'paragraph':
      return `<p>${inline(n)}</p>`;
    case 'bulletList':
    case 'orderedList': {
      const items = kids(n).filter((li) => li.type === 'listItem').map((li) => `<li>${kids(li).map(renderFlow).join('')}</li>`);
      if (!items.length) return '';
      const start = n.attrs?.start;
      if (n.type === 'bulletList') return `<ul>${items.join('')}</ul>`;
      return `<ol${posInt(start) && start > 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>`;
    }
    default:
      return '';
  }
}

function renderCallout(n: Node): string {
  const v = n.attrs?.variant;
  const variant: CalloutVariant = (calloutVariants as readonly unknown[]).includes(v) ? (v as CalloutVariant) : 'nota';
  const label = `<strong>${escapeHtml(CALLOUT_LABELS[variant])}</strong>`;
  const blocks = kids(n);
  // Label goes inline into the first paragraph; otherwise on its own line.
  const body = blocks[0]?.type === 'paragraph'
    ? `<p>${label} ${inline(blocks[0])}</p>${blocks.slice(1).map(renderFlow).join('')}`
    : `<p>${label}</p>${blocks.map(renderFlow).join('')}`;
  return `<div class="rb-callout" role="note" data-variant="${variant}"><div>${body}</div></div>`;
}

function renderImage(n: Node, opts: RenderOptions): string {
  const a = n.attrs ?? {};
  const alt = str(a.alt).trim();
  const assetId = str(a.assetId) || undefined;
  const src = str(a.src) || undefined;
  if (!alt || (!assetId && !src)) return '';
  const img = opts.image(assetId ? { assetId } : { src });
  // The resolver may echo a user-provided src: only http(s) or a root-relative path reaches <img>.
  if (!img || !posInt(img.width) || !posInt(img.height)) return '';
  const imgSrc = img.src.trim();
  if (!isSafeHref(imgSrc) || !(isExternalHref(imgSrc) || imgSrc.startsWith('/'))) return '';
  if (!assetId && !/^https:\/\//i.test(imgSrc)) return ''; // external src: https only (P-433); asset URLs come from our own base
  const caption = str(a.caption).trim();
  return `<figure><img src="${escapeHtml(imgSrc)}"${img.srcset ? ` srcset="${escapeHtml(img.srcset)}"` : ''}${img.sizes ? ` sizes="${escapeHtml(img.sizes)}"` : ''}`
    + ` alt="${escapeHtml(alt)}" width="${img.width}" height="${img.height}" loading="lazy" decoding="async">`
    + `${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
}

const paragraphs = (s: string) => s.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join('');

function renderFaq(n: Node): string {
  const items = Array.isArray(n.attrs?.items) ? (n.attrs.items as { q?: unknown; a?: unknown }[]) : [];
  const html = items
    .filter((i) => i && str(i.q).trim() && str(i.a).trim())
    .map((i) => `<details class="rb-faq-item"><summary>${escapeHtml(str(i.q).trim())}</summary>${paragraphs(str(i.a))}</details>`);
  return html.length ? `<div class="rb-faq">${html.join('')}</div>` : '';
}

/** Top-level blocks the renderer accepts, so heading ids are computed exactly as extractToc does on a valid document. */
const validBlocks = (doc: BlogDoc): Node[] =>
  (Array.isArray(doc?.content) ? (doc.content as Node[]) : []).filter((b) => b && typeof b === 'object' && (b.type !== 'heading' || (isLevel(b.attrs?.level) && (b.content === undefined || Array.isArray(b.content)))));

/**
 * HTML of the post body. Heading ids: h2/h3 = extractToc ids (same order); h4 = slug of its text, deduplicated against every
 * other heading id. Blocks: p, h2–h4, ul/ol/li, blockquote, callout, figure, a.rb-button, FAQ; anything else is dropped.
 */
export function renderPostHtml(doc: BlogDoc, opts: RenderOptions): string {
  const blocks = validBlocks(doc);
  const toc = extractToc({ type: 'doc', content: blocks as BlogBlock[] });
  const used = new Set(toc.map((t) => t.id));
  let t = 0;
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const level = b.attrs!.level as 2 | 3 | 4;
        let id: string;
        if (level === 4) {
          const base = slugify(kids(b).map((c) => str(c.text)).join('').trim()) || 'secao';
          id = base;
          for (let k = 2; used.has(id); k++) id = `${base}-${k}`;
          used.add(id);
        } else id = toc[t++]!.id;
        out.push(`<h${level} id="${escapeHtml(id)}">${inline(b)}</h${level}>`);
        break;
      }
      case 'blockquote':
        out.push(`<blockquote>${kids(b).map(renderFlow).join('')}</blockquote>`);
        break;
      case 'callout':
        out.push(renderCallout(b));
        break;
      case 'image':
        out.push(renderImage(b, opts));
        break;
      case 'button': {
        const text = str(b.attrs?.text).trim();
        const attrs = linkAttrs(b.attrs?.href);
        if (text && attrs) out.push(`<a class="rb-button"${attrs}>${escapeHtml(text)}</a>`);
        break;
      }
      case 'faq':
        out.push(renderFaq(b));
        break;
      default:
        out.push(renderFlow(b));
    }
  }
  return out.join('');
}

export const postWordCount = (doc: BlogDoc): number => countWords(doc);
export const postReadingMinutes = (doc: BlogDoc): number => readingMinutes(countWords(doc));

/** Plain text of the first non-empty top-level paragraph ('' when none): excerpt fallback and keyword check. */
export function firstParagraphText(doc: BlogDoc): string {
  for (const b of doc.content) {
    if (b.type !== 'paragraph') continue;
    const text = (b.content ?? []).map((c) => c.text).join('').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

export type PostSummary = { html: string; toc: BlogTocEntry[]; faq: BlogFaqItem[]; wordCount: number; readingMinutes: number };
/** Everything the API recomputes on each save (content_html, toc_json, faq, word_count, reading_minutes). */
export function renderPostSummary(doc: BlogDoc, opts: RenderOptions): PostSummary {
  const wordCount = postWordCount(doc);
  return { html: renderPostHtml(doc, opts), toc: extractToc(doc), faq: extractFaq(doc), wordCount, readingMinutes: readingMinutes(wordCount) };
}
