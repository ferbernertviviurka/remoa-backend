import {
  bounds,
  examLines,
  pageLines,
  lineQuestionNumber,
  excludeExamMargins,
  inferExamMarkerProfiles,
  type PdfLine,
} from "./layout";
import {
  PdfParserError,
  type AnswerKeyEntry,
  type AnswerKeyResult,
  type ExamParseResult,
  type PdfLayoutPage,
  type Provenance,
  type QuestionCandidate,
  type PdfStructuralWarning,
} from "./types";
import { QUESTION_PDF_PARSER_VERSION } from "@remoa/contracts";
import { extractSharedContexts } from "./shared-context";
const provenance = (line: PdfLine): Provenance => ({
  page: line.page.page,
  bbox: line.bbox,
  method: line.page.method ?? "text",
});
const alternative = /^\s*(?:\(([A-Ja-j])\)|([A-Ja-j])[.)])\s*(.*)$/;
function candidate(lines: PdfLine[], number: number): QuestionCandidate | null {
  let stem = "",
    current: { key: string; text: string } | undefined;
  const alternatives: { key: string; text: string }[] = [];
  const issues: QuestionCandidate["issues"] = [];
  if (lines.some(line=>line.ambiguousColumnPrelude)) issues.push("marker_profile_ambiguous");
  let firstCorroboratedA = -1;
  if (lines[0]?.bareMarkerProfile) {
    const indexA = lines.findIndex(l=>alternative.exec(l.text)?.[1]?.toUpperCase()==='A' || alternative.exec(l.text)?.[2]?.toUpperCase()==='A');
    const next = indexA>=0 ? lines.slice(indexA+1).find(l=>alternative.test(l.text)) : undefined;
    const label = next ? alternative.exec(next.text) : null;
    if (indexA>=0 && (label?.[1]??label?.[2])?.toUpperCase()==='B' && Math.abs(lines[indexA]!.bbox.x-next!.bbox.x)<=Math.max(2,next!.page.width*0.01)) firstCorroboratedA=indexA;
    else if (!issues.includes('marker_profile_ambiguous')) issues.push('marker_profile_ambiguous');
  }
  for (const [index, line] of lines.entries()) {
    let text = line.text;
    if (index === 0)
      text = text.replace(
        /^(?:(?:QUEST[ÃA]O|QUESTION)\s*)?\d{1,3}\s*[{}:.)–-]*\s*/i,
        "",
      );
    const match = firstCorroboratedA>=0 && index<firstCorroboratedA ? null : text.match(alternative);
    if (match) {
      current = {
        key: (match[1] ?? match[2]!).toUpperCase(),
        text: match[3] ?? "",
      };
      alternatives.push(current);
    } else if (current) current.text += ` ${text}`;
    else stem += ` ${text}`;
  }
  // Cover instructions and reference tables with numbered lines are not objective questions.
  if (alternatives.length === 0) return null;
  stem = stem.trim();
  if (alternatives.length < 2) issues.push("missing_alternatives");
  if (new Set(alternatives.map((a) => a.key)).size !== alternatives.length)
    issues.push("duplicate_alternative");
  if (!stem) issues.push("missing_stem");
  const pages = [...new Set(lines.map((l) => l.page.page))];
  const origins = pages.map(
    (page) =>
      ({
        page,
        bbox: bounds(
          lines.filter((l) => l.page.page === page).flatMap((l) => l.items),
        ),
        method: lines.find((l) => l.page.page === page)?.page.method ?? "text",
      }) satisfies Provenance,
  );
  const imageRefs: Provenance[] = [];
  for (const p of pages) {
    const page = lines.find((l) => l.page.page === p)?.page;
    const region = origins.find((o) => o.page === p)?.bbox;
    if (!page || !region) continue;
    for (const image of page.images ?? []) {
      if (
        image.y + image.height >= region.y &&
        image.y <= region.y + region.height &&
        image.x + image.width >= region.x &&
        image.x <= region.x + region.width
      )
        imageRefs.push({ page: p, bbox: image, method: page.method ?? "text" });
    }
  }
  // Retain a page-region crop reference when figures/vector tables are not separately exposed by pdf.js.
  if (
    /imagem|figura|gr[áa]fico|tabela|radiografi|ultrassono|tomografi|eletrocardiograma/i.test(
      stem,
    )
  ) {
    issues.push("visual_review_required");
    if (!imageRefs.length) imageRefs.push(...origins);
  }
  if (
    pages.some(
      (p) => lines.find((l) => l.page.page === p)?.page.images === undefined,
    )
  )
    issues.push("figure_geometry_unknown");
  if (origins.some((o) => o.method === "ocr")) issues.push("ocr_used");
  issues.push("missing_answer_key");
  return {
    originalNumber: number,
    parserMarkerEvidence: {originalNumber: number, provenance: provenance(lines[0]!)},
    stem,
    alternatives: alternatives.map((a) => ({ ...a, text: a.text.trim() })),
    correctKey: null,
    annulled: false,
    provenance: origins,
    imageRefs,
    confidence: {
      stem: stem ? 0.9 : 0.1,
      alternatives: issues.includes("duplicate_alternative")
        ? 0.2
        : alternatives.length >= 2
          ? 0.9
          : 0.3,
      answerKey: 0,
    },
    issues,
    status: "staging",
  };
}
export function parseExam(
  pages: PdfLayoutPage[],
  key?: AnswerKeyResult,
): ExamParseResult {
  const candidates: QuestionCandidate[] = [],
    warnings: string[] = pages
      .filter((p) => p.reviewedNonQuestion)
      .map((p) => `reviewed_non_question_page:${p.page}`);
  let buffer: PdfLine[] = [],
    number: number | null = null;
  const flush = () => {
    if (number !== null) {
      const c = candidate(buffer, number);
      if (c) candidates.push(c);
    }
    buffer = [];
  };
  const markerHeights = pages.flatMap(p=>p.items.filter(i=>/^\s*\d{1,3}\s*[{}]*\s*$/.test(i.text)).map(i=>i.height)).sort((a,b)=>a-b);
  const markerHeight = markerHeights[Math.floor(markerHeights.length/2)] ?? 0;
  const profiles = inferExamMarkerProfiles(pages);
  const filtered = excludeExamMargins(pages);
  const shared = extractSharedContexts(filtered.pages);
  for (const omission of filtered.omitted)
    warnings.push(
      `margin_omitted:${omission.line.page.page}:${omission.reason}`,
    );
  for (const page of shared.pages)
    for (const line of examLines(page, markerHeight, profiles.get(page.page))) {
      const pageProfiles = profiles.get(page.page);
      const next = lineQuestionNumber(line, markerHeight, pageProfiles);
      if(next!==null && /^\s*\d{1,3}\s*[{}]*\s*$/.test(line.text) && pageProfiles?.some(p=>p.bare)) line.bareMarkerProfile=true;
      // An unlabelled column prelude has uncertain attachment. Keep all text and flag review.
      if (line.columnStart && next===null && number!==null && buffer[0]?.bareMarkerProfile && !alternative.test(line.text)) line.ambiguousColumnPrelude=true;
      if (next !== null) {
        flush();
        number = next;
      }
      if (number !== null) buffer.push(line);
    }
  flush();
  const seen = new Set<number>();
  for (const c of candidates) {
    if (shared.contexts.some(context => context.declaredNumbers.includes(c.originalNumber))) {
      c.ownStem = c.stem;
      c.issues.push("shared_context_unresolved");
    }
    if (seen.has(c.originalNumber)) {
      c.issues.push("duplicate_number");
      warnings.push(`duplicate_number:${c.originalNumber}`);
    }
    seen.add(c.originalNumber);
    if (c.alternatives.length>10 || c.issues.includes('duplicate_alternative')) {
      c.issues.push('segmentation_incomplete');
      warnings.push(`segmentation_incomplete:${c.originalNumber}` satisfies PdfStructuralWarning);
    }
    if(c.issues.includes('marker_profile_ambiguous')) warnings.push(`marker_profile_ambiguous:${c.originalNumber}` satisfies PdfStructuralWarning);
    const entry = key?.entries.find((e) => e.number === c.originalNumber);
    if (entry) {
      c.issues = c.issues.filter((i) => i !== "missing_answer_key");
      c.annulled = entry.annulled;
      if (entry.ambiguous) {
        c.issues.push("ambiguous_answer_key");
        c.confidence.answerKey = 0.2;
      } else if (entry.annulled) {
        c.correctKey = null;
        c.confidence.answerKey = 0.8;
      } else if (entry.key && c.alternatives.some((a) => a.key === entry.key)) {
        c.correctKey = entry.key;
        c.confidence.answerKey = 0.95;
      } else {
        c.issues.push("answer_not_in_alternatives");
        c.confidence.answerKey = 0;
      }
    }
  }
  if (seen.size) {
    const max = Math.max(...seen);
    for (let n = Math.min(...seen); n <= max; n++)
      if (!seen.has(n)) warnings.push(`missing_question:${n}`);
  }
  for(const entry of key?.entries ?? []) if(!seen.has(entry.number)) warnings.push(`expected_question_unmatched:${entry.number}` satisfies PdfStructuralWarning);
  if (!candidates.length) warnings.push("no_questions_detected");
  return {
    candidates,
    sharedContexts: shared.contexts,
    warnings,
    pages: pages.length,
    parserVersion: QUESTION_PDF_PARSER_VERSION,
    removedMargins: filtered.omitted.map(({ line, reason }) => ({
      ...provenance(line),
      text: line.text,
      reason,
    })),
  };
}
/** Group selection uses column header positions. Multiple letters are unresolved retifications, not accepted keys. */
interface NumericKeyBlock {
  page: PdfLayoutPage;
  lines: PdfLine[];
  headers: { code: string; line: PdfLine }[];
}
const normalizedNumericCode = (value: string): string | null => {
  const text = value.normalize("NFC").trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1) return null;
  return String(Number(text));
};
/** Only complete metadata headers establish numeric cadernos; body numerals never do. */
function numericKeyBlocks(pages: PdfLayoutPage[]): NumericKeyBlock[] {
  return pages.flatMap(page => {
    const lines = pageLines(page, false);
    if (lines.some(l => /GABARITO DE CORRESPOND[ÊE]NCIA/i.test(l.text))) return [];
    const headers = lines.flatMap(line => {
      const label = line.text.normalize("NFC").trim();
      if (!/\bPROVA\s+\d/i.test(label)) return [];
      if ((label.match(/\bPROVA\s+\d/gi)?.length ?? 0) > 1)
        throw new PdfParserError("ambiguous_key_geometry", "Numeric headers share a line without verified table boundaries");
      const match = /^(?:.+?\s[-–—:]\s*)?PROVA\s+(\d{1,3})(?:\s*[-–—:]\s*.*|\s*)$/i.exec(label);
      const code = match ? normalizedNumericCode(match[1]!) : null;
      if (!code) {
        if (/^(?:.+?\s[-–—:]\s*)?PROVA\s+\d/i.test(label))
          throw new PdfParserError("ambiguous_key_geometry", "Numeric header requires a complete code and explicit description boundary");
        return [];
      }
      const box = line.bbox;
      if (![page.width, page.height, box.x, box.y, box.width, box.height].every(Number.isFinite) ||
          page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 ||
          box.x + box.width > page.width || box.y + box.height > page.height)
        throw new PdfParserError("ambiguous_key_geometry", "Numeric header geometry is invalid");
      return [{ code, line }];
    });
    return headers.length ? [{ page, lines, headers }] : [];
  });
}
function parseNumericAnswerKey(blocks: NumericKeyBlock[], group?: string): AnswerKeyResult {
  const codes = new Set(blocks.flatMap(b => b.headers.map(h => h.code)));
  const selected = group ? normalizedNumericCode(group) : codes.size === 1 ? [...codes][0]! : null;
  if (!selected || !codes.has(selected))
    throw new PdfParserError("group_not_found", "Select an explicit numeric answer-key group for a multi-caderno document");
  const entries: AnswerKeyEntry[] = [], warnings: string[] = [];
  for (const { page, lines, headers } of blocks) {
    for (const [index, header] of headers.entries()) {
      if (header.code !== selected) continue;
      const minY = header.line.bbox.y + header.line.bbox.height;
      const maxY = headers[index + 1]?.line.bbox.y ?? page.height;
      const table = lines.filter(l => l.bbox.y > minY && l.bbox.y + l.bbox.height <= maxY);
      let found = false;
      for (let r = 0; r < table.length; r++) {
        const numbers = table[r]!;
        if (!/^\d+(?:\s+\d+)*$/.test(numbers.text.trim())) continue;
        const keys = table[r + 1];
        // Each PDF item is an observed cell. Never invent glyph widths for a fused row.
        if (!keys || numbers.items.length < 2 || numbers.items.some(i => !/^\d{1,3}$/.test(i.text.trim())) ||
            keys.items.length !== numbers.items.length || keys.items.some(i => !/^(?:[A-Z]{1,3}|[*?])$/.test(i.text.trim())) ||
            keys.bbox.y - numbers.bbox.y > Math.max(numbers.bbox.height, keys.bbox.height) * 2.5 ||
            keys.bbox.y < numbers.bbox.y + numbers.bbox.height)
          throw new PdfParserError("ambiguous_key_geometry", "Numeric table requires aligned separate number and key cells");
        const cells = [...numbers.items].sort((a, b) => a.x - b.x);
        const answers = [...keys.items].sort((a, b) => a.x - b.x);
        for (let c = 0; c < cells.length; c++) {
          const cell = cells[c]!, answer = answers[c]!;
          for (const item of [cell, answer]) {
            if (![item.x, item.y, item.width, item.height].every(Number.isFinite) || item.width <= 0 || item.height <= 0 ||
                item.x < 0 || item.y < 0 || item.x + item.width > page.width || item.y + item.height > page.height)
              throw new PdfParserError("ambiguous_key_geometry", "Numeric cell geometry is invalid");
          }
          const center = cell.x + cell.width / 2;
          if (Math.abs(center - answer.x - answer.width / 2) > Math.max(2, Math.min(cell.height, answer.height) * 0.35) ||
              (c > 0 && center <= cells[c - 1]!.x + cells[c - 1]!.width))
            throw new PdfParserError("ambiguous_key_geometry", "Numeric table columns do not align uniquely");
          const number = Number(cell.text.trim()), raw = answer.text.trim();
          if (number < 1 || number > 999 || entries.some(e => e.number === number))
            throw new PdfParserError("ambiguous_key_geometry", "Repeated numeric question requires an explicit answer-key page selection");
          const ambiguous = !/^[A-J]$/.test(raw);
          if (ambiguous) warnings.push(`unknown_or_ambiguous_key:${number}`);
          entries.push({ number, raw, key: ambiguous ? null : raw, ambiguous, annulled: false,
            provenance: provenance({ ...numbers, items: [cell, answer], bbox: bounds([cell, answer]) }) });
        }
        found = true;
        r++;
      }
      if (!found) throw new PdfParserError("ambiguous_key_geometry", "Numeric caderno has no verified paired grid");
    }
  }
  return { entries: entries.sort((a, b) => a.number - b.number), warnings, group: selected };
}

/** GRUPO tables have explicit question/alternative column labels and same-row cells. */
function parseGroupedAnswerKey(pages: PdfLayoutPage[], group?: string): AnswerKeyResult | null {
  const blocks = pages.flatMap(page => {
    const lines = pageLines(page, false);
    if (!lines.some(l => /^GABARITO(?:\s+DEFINITIVO|\s+PRELIMINAR)?$/i.test(l.text.trim()))) return [];
    const headers = lines.flatMap(line => {
      const match = /^GRUPO\s+(\d{1,3})(?:\s*[-–—:]\s*.+)?$/i.exec(line.text.trim());
      if (!match && /^GRUPO\s+\d/i.test(line.text.trim())) throw new PdfParserError("ambiguous_key_geometry", "GRUPO requires a complete numeric code and explicit description boundary");
      return match ? [{code: normalizedNumericCode(match[1]!)!, line}] : [];
    });
    if (headers.length > 1) throw new PdfParserError("ambiguous_key_geometry", "Multiple GRUPO headers share an answer-key page");
    if (headers.length && (![page.width,page.height].every(Number.isFinite) || page.width<=0 || page.height<=0 || headers.some(h=>[h.line.bbox.x,h.line.bbox.y,h.line.bbox.width,h.line.bbox.height].some(v=>!Number.isFinite(v)) || h.line.bbox.width<=0 || h.line.bbox.height<=0 || h.line.bbox.x<0 || h.line.bbox.y<0 || h.line.bbox.x+h.line.bbox.width>page.width || h.line.bbox.y+h.line.bbox.height>page.height)))
      throw new PdfParserError("ambiguous_key_geometry", "GRUPO header geometry is invalid");
    return headers.length ? [{page, lines, header: headers[0]!}] : [];
  });
  if (!blocks.length) return null;
  if (!group && pages.some(p => pageLines(p, false).some(l => /^PROVA\s+(?:[A-Z]+\d*|\d+)/i.test(l.text.trim()))))
    throw new PdfParserError("group_not_found", "Select an explicit group for mixed answer-key formats");
  const codes = new Set(blocks.map(b => b.header.code));
  const selected = group ? normalizedNumericCode(group) : codes.size === 1 ? [...codes][0]! : null;
  if (!selected || !codes.has(selected)) throw new PdfParserError("group_not_found", "Select an explicit GRUPO answer-key group");
  const entries: AnswerKeyEntry[] = [], warnings: string[] = [];
  for (const {page, lines, header} of blocks) {
    if (header.code !== selected) continue;
    const labels = lines.filter(l => l.bbox.y > header.line.bbox.y + header.line.bbox.height)
      .flatMap(l => l.items.filter(i => /^(?:QUESTÕES|ALTERNATIVAS)$/.test(i.text.trim())));
    if (!labels.length || labels.length % 2) throw new PdfParserError("ambiguous_key_geometry", "GRUPO requires explicit paired column labels");
    if (labels.some(i=>![i.x,i.y,i.width,i.height].every(Number.isFinite)||i.width<=0||i.height<=0||i.x<0||i.y<0||i.x+i.width>page.width||i.y+i.height>page.height))
      throw new PdfParserError("ambiguous_key_geometry", "GRUPO column geometry is invalid");
    const columns = [...labels].sort((a,b) => a.x-b.x);
    const center = (i: typeof columns[number]) => i.x+i.width/2;
    for (let c=0;c<columns.length;c+=2) {
      const numberLabel=columns[c]!, keyLabel=columns[c+1]!;
      if (numberLabel.text.trim()!=="QUESTÕES" || keyLabel.text.trim()!=="ALTERNATIVAS" ||
          Math.abs(numberLabel.y-keyLabel.y)>Math.min(numberLabel.height,keyLabel.height)*0.3)
        throw new PdfParserError("ambiguous_key_geometry", "GRUPO column labels do not align");
      const left=c===0?0:(center(columns[c-1]!)+center(numberLabel))/2;
      const middle=(center(numberLabel)+center(keyLabel))/2;
      const right=c+2===columns.length?page.width:(center(keyLabel)+center(columns[c+2]!))/2;
      const tableBottom = Math.max(...lines.filter(l => l.bbox.y > keyLabel.y + keyLabel.height && l.items.some(i => center(i) >= middle && center(i) < right && /^(?:[A-J]|NULA)$/.test(i.text.trim()))).map(l => l.bbox.y + l.bbox.height));
      let numberAnchor: number | null = null;
      for (const line of lines.filter(l=>l.bbox.y>Math.max(numberLabel.y+numberLabel.height,keyLabel.y+keyLabel.height))) {
        const numbers=line.items.filter(i=>center(i)>=left&&center(i)<middle);
        const answers=line.items.filter(i=>center(i)>=middle&&center(i)<right);
        if (!numbers.some(i=>/^\d{1,3}$/.test(i.text.trim()))) continue;
        if (numberAnchor !== null && numbers.length === 1 && Math.abs(center(numbers[0]!)-numberAnchor)>numbers[0]!.height*0.35) {
          if (line.bbox.y > tableBottom) continue;
          throw new PdfParserError("ambiguous_key_geometry", "GRUPO numeric cell leaves its observed column anchor");
        }
        if(numbers.length!==1 || answers.length!==1 || !/^\d{1,3}$/.test(numbers[0]!.text.trim()))
          throw new PdfParserError("ambiguous_key_geometry", "GRUPO cells require one observed number and one literal token");
        const n=numbers[0]!, a=answers[0]!;
        numberAnchor ??= center(n);
        for(const item of [n,a]) if(![item.x,item.y,item.width,item.height].every(Number.isFinite)||item.width<=0||item.height<=0||item.x<0||item.y<0||item.x+item.width>page.width||item.y+item.height>page.height)
          throw new PdfParserError("ambiguous_key_geometry", "GRUPO cell geometry is invalid");
        if(Math.abs(n.y+n.height/2-a.y-a.height/2)>Math.min(n.height,a.height)*0.3)
          throw new PdfParserError("ambiguous_key_geometry", "GRUPO number and token baselines differ");
        const number=Number(n.text.trim()),raw=a.text.trim();
        if(!number||entries.some(e=>e.number===number)) throw new PdfParserError("ambiguous_key_geometry", "Repeated GRUPO number requires explicit page selection");
        const annulled=raw==="NULA", ambiguous=!annulled&&!/^[A-J]$/.test(raw);
        if(ambiguous)warnings.push(`unknown_or_ambiguous_key:${number}`);
        entries.push({number,raw,key:annulled||ambiguous?null:raw,annulled,ambiguous,provenance:provenance({...line,items:[n,a],bbox:bounds([n,a])})});
      }
    }
  }
  if(!entries.length)throw new PdfParserError("ambiguous_key_geometry", "GRUPO has no verified cells");
  return {entries:entries.sort((a,b)=>a.number-b.number),warnings,group:selected};
}

export function parseAnswerKey(
  pages: PdfLayoutPage[],
  group?: string,
): AnswerKeyResult {
  const grouped = parseGroupedAnswerKey(pages, group);
  if (grouped) return grouped;
  const numeric = numericKeyBlocks(pages);
  if (numeric.length) {
    const alphaCodes = new Set(pages.flatMap(page => {
      const lines = pageLines(page, false);
      if (lines.some(l => /GABARITO DE CORRESPOND[ÊE]NCIA/i.test(l.text))) return [];
      return lines.flatMap(l => [...l.text.matchAll(/\bPROVA\s+([A-Z]+\d*)(?=\s*[-–—:]|\s*$)/gi)].map(m => m[1]!.toUpperCase()));
    }));
    if (!group && alphaCodes.size) throw new PdfParserError("group_not_found", "Select an explicit answer-key group for a mixed-caderno document");
    if (!group || normalizedNumericCode(group)) return parseNumericAnswerKey(numeric, group);
  }
  const entries: AnswerKeyEntry[] = [],
    warnings: string[] = [];
  let foundGroup = !group;
  const documentGroups = new Set<string>();
  for (const page of pages) {
    const lines = pageLines(page, false);
    if (lines.some((l) => /GABARITO DE CORRESPOND[ÊE]NCIA/i.test(l.text)))
      continue;
    const headerLines = lines.filter((l) => /PROVA\s+[A-Z]+\d*/i.test(l.text));
    const headers = headerLines
      .flatMap((l) => {
        const text = l.items;
        const result: { name: string; x: number; y: number; described: boolean }[] = [];
        for (let i = 0; i < text.length; i++) {
          if (!/^PROVA(?:\s|$)/i.test(text[i]!.text)) continue;
          const parts = [text[i]!];
          for (
            let j = i + 1;
            j < text.length && !/^PROVA(?:\s|$)/i.test(text[j]!.text);
            j++
          )
            parts.push(text[j]!);
          const label = parts.map((t) => t.text).join(" ").normalize("NFC").trim();
          // Capture the complete code, never a prefix of AA/A1 or an unbounded description.
          const match = /^PROVA\s+([A-Z]+\d*)(?:\s*([-–—:])\s*.*|\s*)$/i.exec(label);
          if (match) {
            if ((label.match(/\bPROVA\s+[A-Z]+\d*/gi)?.length ?? 0) > 1)
              throw new PdfParserError("ambiguous_key_geometry", "Multiple described groups share one text item; review the original answer-key page");
            const box = bounds(parts);
            result.push({ name: match[1]!.toUpperCase(), x: box.x + box.width / 2, y: box.y + box.height, described: !!match[2] });
          }
        }
        return result;
      })
      .sort((a, b) => a.x - b.x);
    const unique = headers.filter(
      (h, i) =>
        !headers
          .slice(0, i)
          .some((a) => a.name === h.name && Math.abs(a.x - h.x) < 5),
    );
    for (const header of unique) documentGroups.add(header.name);
    if (!group && documentGroups.size > 1)
      throw new PdfParserError("group_not_found", "Select an explicit answer-key group for a multi-caderno document");
    if (unique.length > 1 && unique.some(h => h.described) && (!group || unique.some(h => h.name === group.normalize("NFC").trim().toUpperCase())))
      throw new PdfParserError("ambiguous_key_geometry", "Described multi-group headers require verified code geometry; review the original answer-key page");
    if (!group && unique.length > 1)
      throw new PdfParserError(
        "group_not_found",
        "Select an explicit answer-key group for a multi-caderno document",
      );
    let minX = 0,
      maxX = page.width,
      minY = 0;
    if (group && unique.length) {
      const index = unique.findIndex((h) => h.name === group.normalize("NFC").trim().toUpperCase());
      if (index < 0) continue;
      foundGroup = true;
      const selected = unique[index]!;
      minX = index === 0 ? 0 : (unique[index - 1]!.x + selected.x) / 2;
      maxX =
        index === unique.length - 1
          ? page.width
          : (selected.x + unique[index + 1]!.x) / 2;
      minY = selected.y;
    } else if (group) {
      continue;
    }
    for (const line of lines) {
      if (line.bbox.y <= minY) continue;
      const items = line.items.filter((i) => i.x >= minX && i.x < maxX);
      const text = items.map((i) => i.text).join(" ");
      // Normal rows are number-key pairs; attached letters BA and spaced B A remain ambiguous.
      const matches = [
        ...text.matchAll(
          /(?:^|\s)(\d{1,3})\s+([A-J*](?:\s*[A-J*])*)(?=\s+\d|\s*$)/g,
        ),
      ];
      for (const m of matches) {
        const number = Number(m[1]),
          raw = m[2]!.replace(/\s+/g, "");
        if (!number) continue;
        const annulled = raw === "*",
          ambiguous = raw.length !== 1;
        const entry: AnswerKeyEntry = {
          number,
          key: annulled || ambiguous ? null : raw,
          annulled,
          ambiguous,
          raw: m[2]!,
          provenance: provenance({ ...line, items, bbox: bounds(items) }),
        };
        const prev = entries.find((e) => e.number === number);
        if (prev) {
          if (prev.raw !== entry.raw) {
            prev.ambiguous = true;
            prev.key = null;
            warnings.push(`conflicting_key:${number}`);
          }
        } else entries.push(entry);
      }
    }
  }
  if (!foundGroup)
    throw new PdfParserError(
      "group_not_found",
      `Answer-key group ${group} was not found`,
    );
  if (!entries.length) warnings.push("no_answer_keys_detected");
  return {
    entries: entries.sort((a, b) => a.number - b.number),
    warnings,
    group: group ?? null,
  };
}
