import type { PdfBox, PdfLayoutItem, PdfLayoutPage } from "./types";
export interface PdfLine {
  text: string;
  items: PdfLayoutItem[];
  page: PdfLayoutPage;
  bbox: PdfBox;
  /** Private marker evidence; enables narrow alternative-start handling for learned bare-number regions. */
  bareMarkerProfile?: boolean;
  columnStart?: boolean;
  ambiguousColumnPrelude?: boolean;
}
export const bounds = (items: PdfLayoutItem[]): PdfBox => {
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...items.map((i) => i.x)),
    y = Math.min(...items.map((i) => i.y));
  return {
    x,
    y,
    width: Math.max(...items.map((i) => i.x + i.width)) - x,
    height: Math.max(...items.map((i) => i.y + i.height)) - y,
  };
};
/** Position-based lines; large horizontal gaps split columns instead of joining unrelated stems. */
export function pageLines(page: PdfLayoutPage, splitGaps = true): PdfLine[] {
  const sorted = page.items
    .filter((i) => i.text.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfLayoutItem[][] = [];
  for (const item of sorted) {
    const row = rows.find(
      (r) =>
        Math.abs(r[0]!.y - item.y) <=
        Math.max(2, Math.min(r[0]!.height, item.height) * 0.35),
    );
    if (row) row.push(item);
    else rows.push([item]);
  }
  const lines: PdfLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const groups: PdfLayoutItem[][] = [[]];
    for (const item of row) {
      const prev = groups.at(-1)?.at(-1);
      if (splitGaps && prev && item.x - prev.x - prev.width > page.width * 0.07)
        groups.push([]);
      groups.at(-1)?.push(item);
    }
    for (const items of groups)
      lines.push({
        text: items
          .map((i) => i.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        items,
        page,
        bbox: bounds(items),
      });
  }
  return lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}
export function questionNumber(text: string): number | null {
  const explicit = text.match(
    /^(?:QUEST[ÃA]O|QUESTION)\s*(\d{1,3})\b(?:\s*[:.)–-])?/i,
  );
  const standalone = text.match(/^\s*(\d{1,3})\s*[{}]*\s*$/);
  const prefixed = text.match(/^\s*(\d{1,3})[.)]\s+\S/);
  const raw = explicit?.[1] ?? standalone?.[1] ?? prefixed?.[1];
  const n = raw ? Number(raw) : 0;
  return n >= 1 && n <= 999 ? n : null;
}
/** Detect column-major question layouts from question anchors, never from a table alone. */
export interface ExamMarkerProfile { x: number; height: number; bare: boolean }
const bareNumber = /^\s*\d{1,3}\s*[{}]*\s*$/;
const optionPrefix = /^\s*(?:\(([A-J])\)|([A-J])[.)])(?:\s|$)/i;
const median = (values: number[]) => {
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)] ?? 0;
};
/** A first standalone marker may be slightly outdented from its corroborated option column.
 * Require a nearby aligned text continuation before that column's first option; interior table cells cannot qualify. */
function markerMatchesProfile(item: PdfLayoutItem, page: PdfLayoutPage, profile: ExamMarkerProfile): boolean {
  const tolerance=Math.max(2,page.width*0.01);
  if (Math.abs(item.x-profile.x)<=tolerance) return true;
  const offset=profile.x-item.x;
  if (!bareNumber.test(item.text) || offset<=0 || offset>profile.height) return false;
  const options=page.items.filter(i=>optionPrefix.test(i.text) && Math.abs(i.x-profile.x)<=tolerance);
  const firstOption=Math.min(...options.map(i=>i.y));
  if (!(item.y+item.height<firstOption)) return false;
  const following=page.items.filter(i=>i.y>item.y && i.y<firstOption && Math.abs(i.x-profile.x)<=tolerance).sort((a,b)=>a.y-b.y)[0];
  return !!following && following.y-item.y<=profile.height*3 && /[A-Za-zÀ-ÿ]/.test(following.text) && !questionNumber(following.text) && !optionPrefix.test(following.text);
}
/** Profiles originate from observed option-prefix positions, never from arbitrary table numerals or a cover maximum. */
export function inferExamMarkerProfiles(pages: PdfLayoutPage[]): Map<number, ExamMarkerProfile[]> {
  const profiles = new Map<number, ExamMarkerProfile[]>();
  const learn = (items: PdfLayoutItem[], width: number) => {
    const clusters: {x:number; items:PdfLayoutItem[]; keys:Set<string>}[] = [];
    for (const item of items) {
      const match = optionPrefix.exec(item.text);
      if (!match) continue;
      const cluster = clusters.find(c=>Math.abs(c.x-item.x)<=Math.max(2,width*0.01));
      if (cluster) {cluster.items.push(item);cluster.keys.add((match[1]??match[2]!).toUpperCase());}
      else clusters.push({x:item.x,items:[item],keys:new Set([(match[1]??match[2]!).toUpperCase()])});
    }
    return clusters.filter(c=>c.keys.size>=2).map(c=>({x:median(c.items.map(i=>i.x)),height:median(c.items.map(i=>i.height)),bare:false}));
  };
  for (const page of pages) {
    const local = learn(page.items,page.width);
    // A continuation can reuse a profile only from pages with the same viewport geometry.
    const learned = local.length ? local : learn(pages.filter(p=>Math.abs(p.width-page.width)<1 && Math.abs(p.height-page.height)<1).flatMap(p=>p.items),page.width);
    profiles.set(page.page,learned.map(profile=>({...profile,bare:pages.filter(p=>Math.abs(p.width-page.width)<1 && Math.abs(p.height-page.height)<1).flatMap(p=>p.items).some(i=>bareNumber.test(i.text) && Number(i.text.replace(/[{}]/g,'').trim())>=1 && markerMatchesProfile(i,page,profile) && i.height>=profile.height*0.75 && i.height<=profile.height*2)})));
  }
  return profiles;
}
export function lineQuestionNumber(
  line: PdfLine,
  minMarkerHeight = 0,
  profiles?: ExamMarkerProfile[],
): number | null {
  const n = questionNumber(line.text);
  if (n === null) return null;
  if (profiles?.length && !/^(?:QUEST[ÃA]O|QUESTION)\b/i.test(line.text)) {
    const profile = profiles.find(p=>markerMatchesProfile({text:line.text,...line.bbox},line.page,p) && line.bbox.height>=p.height*0.75 && line.bbox.height<=p.height*2);
    if (!profile || (profile.bare && !bareNumber.test(line.text))) return null;
    return n;
  }
  if (
    !/^(?:QUEST[ÃA]O|QUESTION)\b/i.test(line.text) &&
    line.bbox.height < minMarkerHeight * 0.85
  )
    return null;
  return n;
}
/** Only page margins with spatial and metadata/repetition evidence are omitted.
 * Run before column ordering, so the next header cannot extend a prior alternative.
 */
export function excludeExamMargins(pages: PdfLayoutPage[]) {
  const rows = pages.map((page) => ({ page, lines: pageLines(page) }));
  const markerProfiles = inferExamMarkerProfiles(pages);
  const officialHeader = (line: PdfLine) => /^(?:Exame Nacional de Resid[êe]ncia|INSTITUTO AOCP)$/i.test(line.text.normalize('NFC').trim());
  const officialFooter = (line: PdfLine) => /^(?:PRM\s*[-–—]\s*ACESSO DIRETO|Tipo\s+\d{1,3}\s*[-–—]\s*P[áa]gina\s+\d{1,3})$/i.test(line.text.normalize('NFC').trim());
  const officialSignature = (line: PdfLine) => line.text.normalize('NFC').replace(/\s+/g,' ').trim().toUpperCase().replace(/^TIPO\s+\d+\s*[-–—]\s*PÁGINA\s+\d+$/, 'TIPO N - PÁGINA N');
  const repeatedOfficialMargin = (line: PdfLine, first: number) => {
    const top = officialHeader(line) && line.bbox.y + line.bbox.height <= line.page.height*0.09 && line.bbox.y<first;
    const bottom = officialFooter(line) && line.bbox.y>=line.page.height*0.92;
    const bodyHeight = median((markerProfiles.get(line.page.page)??[]).map(p=>p.height));
    if ((!top && !bottom) || !bodyHeight || line.bbox.height>bodyHeight+0.01) return false;
    return rows.some(row=>row.page.page!==line.page.page && row.lines.some(other=>
      officialSignature(other)===officialSignature(line) &&
      (top ? officialHeader(other) && other.bbox.y+other.bbox.height<=other.page.height*0.09 : officialFooter(other) && other.bbox.y>=other.page.height*0.92) &&
      Math.abs(other.bbox.height-line.bbox.height)<=Math.max(0.1,line.bbox.height*0.1) &&
      Math.abs(other.bbox.x/other.page.width-line.bbox.x/line.page.width)<=0.01 &&
      Math.abs(other.bbox.y/other.page.height-line.bbox.y/line.page.height)<=Math.max(2,line.bbox.height*0.5)/line.page.height));
  };
  const firstQuestion = (lines: PdfLine[]) =>
    Math.min(
      Infinity,
      ...lines
        .filter((l) => questionNumber(l.text) !== null)
        .map((l) => l.bbox.y),
    );
  const inHeader = (line: PdfLine, first: number) =>
    line.bbox.y + line.bbox.height <= line.page.height * 0.09 &&
    line.bbox.y < first;
  const inFooter = (line: PdfLine) => line.bbox.y >= line.page.height * 0.92;
  const signature = (line: PdfLine) =>
    line.text.normalize("NFC").replace(/\s+/g, " ").trim();
  // Repetition alone is never evidence that a clinical sentence is metadata.
  const safeRepeatedLabel = (line: PdfLine) =>
    /^(?:CADERNO\s+(?:ESPECIAL|DE\s+QUEST[ÕO]ES|[A-Z]\d{0,3})|PROCESSO\s+SELETIVO(?:\s*[-–]\s*\d{4})?|RESID[ÊE]NCIA\s+M[ÉE]DICA(?:\s*[-–]\s*\d{4})?)$/i.test(
      signature(line),
    );
  // A custom title is learned only from the first actual question page's metadata cluster.
  // A repeated clinical sentence on continuation pages cannot establish that cluster.
  const firstQuestionPage = rows.find((row) =>
    Number.isFinite(firstQuestion(row.lines)),
  );
  const metadataTitles =
    firstQuestionPage?.lines.filter(
      (title) =>
        /^Processo Seletivo\s*[-–]\s+\S.{0,200}$/i.test(title.text) &&
        inHeader(title, firstQuestion(firstQuestionPage.lines)) &&
        firstQuestionPage.lines.some(
          (label) =>
            /^PROVA\s+[A-Z]{1,6}\d{1,3}$/i.test(label.text) &&
            inHeader(label, firstQuestion(firstQuestionPage.lines)) &&
            label.bbox.y + label.bbox.height <= title.bbox.y &&
            title.bbox.y - label.bbox.y - label.bbox.height <=
              label.bbox.height * 2 &&
            Math.abs(title.bbox.x - label.bbox.x) <= title.page.width * 0.03 &&
            title.bbox.height <= label.bbox.height + 1,
        ),
    ) ?? [];
  const contextualTitle = (line: PdfLine) =>
    metadataTitles.some(
      (title) =>
        signature(title) === signature(line) &&
        Math.abs(
          title.bbox.x / title.page.width - line.bbox.x / line.page.width,
        ) < 0.03 &&
        Math.abs(
          title.bbox.y / title.page.height - line.bbox.y / line.page.height,
        ) < 0.025,
    );
  const headerCandidates = new Map<string, PdfLine[]>();
  for (const row of rows) {
    const first = firstQuestion(row.lines);
    for (const line of row.lines) {
      if (
        !inHeader(line, first) ||
        !(safeRepeatedLabel(line) || contextualTitle(line))
      )
        continue;
      const key = signature(line),
        group = headerCandidates.get(key) ?? [];
      group.push(line);
      headerCandidates.set(key, group);
    }
  }
  const repeated = (line: PdfLine) =>
    (headerCandidates.get(signature(line)) ?? []).some(
      (other) =>
        other.page.page !== line.page.page &&
        Math.abs(
          other.bbox.x / other.page.width - line.bbox.x / line.page.width,
        ) < 0.03 &&
        Math.abs(
          other.bbox.y / other.page.height - line.bbox.y / line.page.height,
        ) < 0.025,
    );
  // D-1807 running margins: a page number is a bare integer, bottom-most in the footer band, outside any marker
  // column, repeated at the same position on another page with the same page-index offset. A running header is
  // removed only on pages with such a proven footer: top-most line in the header band, separated by a blank gap,
  // not taller than the page's body text, and repeated verbatim at the same position on another proven page.
  const tol = (line: PdfLine) => Math.max(2, line.page.width * 0.01);
  const pageNumbers = rows.flatMap(({ page, lines }) => lines.filter(line =>
    /^\d{1,3}$/.test(line.text) && line.bbox.y >= page.height * 0.92 &&
    lines.every(other => other === line || other.bbox.y < line.bbox.y) &&
    !(markerProfiles.get(page.page) ?? []).some(p => Math.abs(p.x - line.bbox.x) <= tol(line))));
  const offset = (line: PdfLine) => Number(line.text) - line.page.page;
  const samePlace = (a: PdfLine, b: PdfLine, center = false) =>
    Math.abs((center ? a.bbox.x + a.bbox.width / 2 : a.bbox.x) / a.page.width - (center ? b.bbox.x + b.bbox.width / 2 : b.bbox.x) / b.page.width) <= 0.01 &&
    Math.abs(a.bbox.y / a.page.height - b.bbox.y / b.page.height) <= 0.005;
  const provenPageNumbers = new Set(pageNumbers.filter(line => pageNumbers.some(other =>
    other.page.page !== line.page.page && offset(other) === offset(line) && samePlace(other, line, true))));
  const numberedPages = new Set([...provenPageNumbers].map(line => line.page.page));
  const topLine = (page: PdfLayoutPage, lines: PdfLine[]) => {
    const [line, next] = [...lines].sort((a, b) => a.bbox.y - b.bbox.y);
    if (!line || line.bbox.y + line.bbox.height > page.height * 0.09 || (next && next.bbox.y < line.bbox.y + line.bbox.height * 2) ||
        line.bbox.height > median(lines.map(l => l.bbox.height)) + 0.01 || questionNumber(line.text) !== null ||
        /^\s*(?:\([A-J]\)|[A-J][.)])/i.test(line.text)) return null;
    return line;
  };
  const tops = rows.map(({ page, lines }) => topLine(page, lines)).filter((l): l is PdfLine => !!l);
  const sameHeader = (a: PdfLine, b: PdfLine) => signature(a) === signature(b) && Math.abs(a.bbox.height - b.bbox.height) <= 0.1 && samePlace(a, b);
  const runningHeaderCandidates = tops.filter(line => numberedPages.has(line.page.page));
  const provenHeaders = runningHeaderCandidates.filter(line => runningHeaderCandidates.some(other => other.page.page !== line.page.page && sameHeader(other, line)));
  // D-1813: OCR can miss a page number; a top line identical in text and position to a header already proven on
  // numbered pages is the same running header. Exact match only.
  const runningHeaders = new Set(tops.filter(line => provenHeaders.some(h => sameHeader(h, line))));
  const omitted: {
    line: PdfLine;
    reason: "known_margin" | "repeated_margin";
  }[] = [];
  const output = rows.map(({ page, lines }) => {
    const removed = new Set<PdfLayoutItem>();
    const first = firstQuestion(lines);
    for (const line of lines) {
      // A clinical body sentence starting with PROVA/CADERNO is never a general header regex.
      const knownHeader = /^PROVA\s+[A-Z]{1,6}\d{1,3}$/i.test(line.text);
      const knownFooter = /^(?:Página\s+\d+|\d+\s*\/\s*\d+)$/i.test(line.text);
      const isKnown =
        (inHeader(line, first) && knownHeader) ||
        (inFooter(line) && knownFooter);
      const isRepeated =
        inHeader(line, first) &&
        (safeRepeatedLabel(line) || contextualTitle(line)) &&
        repeated(line) &&
        !questionNumber(line.text) &&
        !/^\s*(?:\([A-J]\)|[A-J][.)])/i.test(line.text);
      const isOfficial = repeatedOfficialMargin(line, first) || provenPageNumbers.has(line) || runningHeaders.has(line);
      if (!isKnown && !isRepeated && !isOfficial) continue;
      omitted.push({
        line,
        reason: isKnown ? "known_margin" : "repeated_margin",
      });
      for (const item of line.items) removed.add(item);
    }
    return { ...page, items: page.items.filter((item) => !removed.has(item)) };
  });
  return { pages: output, omitted };
}
export function examLines(page: PdfLayoutPage, minMarkerHeight = 0, profiles?: ExamMarkerProfile[]): PdfLine[] {
  const markers = page.items.filter(i=>lineQuestionNumber({text:i.text,items:[i],page,bbox:bounds([i])},minMarkerHeight,profiles)!==null);
  const left = markers.some((i) => i.x < page.width * 0.4),
    right = markers.some((i) => i.x > page.width * 0.45);
  const clean = (lines: PdfLine[]) =>
    lines.filter((l) => !/^\s*[{}]+\s*$/.test(l.text));
  const positions = [...new Set(markers.map(i=>profiles?.find(p=>Math.abs(p.x-i.x)<=Math.max(2,page.width*0.01))?.x).filter((x):x is number=>x!==undefined))].sort((a,b)=>a-b);
  if (positions.length<2 && (!left || !right)) return clean(pageLines(page));
  // Profile x is a column's left edge, not its center. The midpoint of two left edges
  // cuts the first column's words. Use observed left-column right bounds and the next left edge.
  const leftEnds = positions.length===2 ? page.items.filter(i=>i.x>=positions[0]! && i.x<positions[1]! && i.x+i.width<positions[1]!).map(i=>i.x+i.width) : [];
  const mid = leftEnds.length ? (Math.max(...leftEnds)+positions[1]!)/2 : page.width * 0.5;
  // Partition before row grouping: two stems can touch the gutter with no large gap.
  const leftLines = pageLines({
    ...page,
    items: page.items.filter((i) => i.x < mid),
  });
  const rightLines = pageLines({
    ...page,
    items: page.items.filter((i) => i.x >= mid),
  });
  const rightClean = clean(rightLines);
  if (rightClean[0]) rightClean[0].columnStart = true;
  return [...clean(leftLines), ...rightClean];
}
/** Complete label at the START of an original pdf.js item. Never matched inside concatenated text. */
const itemLabel = /^\s*(?:\(([A-J])\)|([A-J])[.)])(?:\s|$)/;
const fusedLabel = /(?:^|\s)(?:\(([A-J])\)|([A-J])[.)])(?=\s)/g;
export const labelKey = (text: string): string | null => {
  const m = itemLabel.exec(text);
  return m ? (m[1] ?? m[2]!) : null;
};
/** Exam-only (D-1803): a row of horizontally printed alternatives is split only at original items whose
 * start is a complete label, on the same baseline, after a column-sized gap and in increasing letter order.
 * Boxes are the real item boxes; glyph widths are never estimated. Label-like items failing that proof keep
 * the row intact (`ambiguous`). `fused` lists later labels seen inside an item's text, for review only. */
export function splitAlternativeRow(line: PdfLine): { lines: PdfLine[]; ambiguous: boolean; fused: string[] } {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const first = items[0];
  let key = first ? labelKey(first.text) : null;
  const fusedIn = (group: PdfLayoutItem[], own: string | null) => {
    const text = group.map(i => i.text).join(" ").replace(itemLabel, "");
    return [...text.matchAll(fusedLabel)].map(m => m[1] ?? m[2]!).filter(k => !own || k > own);
  };
  if (!first || !key) return { lines: [line], ambiguous: false, fused: [] };
  const groups: PdfLayoutItem[][] = [[first]];
  let ambiguous = false;
  for (const item of items.slice(1)) {
    const next = labelKey(item.text), prev = groups.at(-1)!.at(-1)!;
    if (next) {
      const sameBaseline = Math.abs(item.y + item.height - first.y - first.height) <= Math.max(1, first.height * 0.2) &&
        Math.abs(item.height - first.height) <= first.height * 0.2;
      const gutter = item.x - prev.x - prev.width >= first.height * 0.8;
      if (next > key! && sameBaseline && gutter) { groups.push([item]); key = next; continue; }
      ambiguous = true;
    }
    groups.at(-1)!.push(item);
  }
  const fused = groups.flatMap(g => fusedIn(g, labelKey(g[0]!.text)));
  if (groups.length === 1) return { lines: [line], ambiguous, fused };
  return {
    lines: groups.map(g => ({ ...line, items: g, bbox: bounds(g), text: g.map(i => i.text).join(" ").replace(/\s+/g, " ").trim() })),
    ambiguous,
    fused,
  };
}
