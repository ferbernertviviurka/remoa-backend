import { pageLines, bounds, type PdfLine } from "./layout";
import type {
  AnswerKeyEntry,
  AnswerKeyResult,
  PdfLayoutPage,
  Provenance,
} from "./types";

/** Caller attests document/capa identity separately: raster headers may have no text layer.
 * This scope is not an authorization, physician signature or publication gate. */
export interface EnadeAnswerKeyScope {
  documentId: string;
  documentSha256: string;
  year: number;
  course: string;
  bookletIdentity: { code: string; label: string };
  identityVerified: boolean;
  finality: "final" | "preliminary" | "unknown";
  expectedObjectiveNumbers: readonly number[];
  expectedDiscursiveNumbers: readonly number[];
}
export interface EnadeKeyEvidence {
  number: number;
  raw: string;
  provenance: Provenance;
}
export interface EnadeAnswerKeyResult extends AnswerKeyResult {
  scope: EnadeAnswerKeyScope;
  discursiveRows: EnadeKeyEvidence[];
  retifications: EnadeKeyEvidence[];
  excludedPerceptionRows: { raw: string; provenance: Provenance }[];
  structuralNeedsReview: boolean;
}
export type EnadeKeyErrorCode =
  | "scope_unverified"
  | "unsupported_year"
  | "finality_pending"
  | "invalid_geometry"
  | "ambiguous_header"
  | "table_header_missing"
  | "ambiguous_cells"
  | "ambiguous_enumeration"
  | "unrecognized_row";
export class EnadeAnswerKeyError extends Error {
  constructor(
    readonly code: EnadeKeyErrorCode,
    readonly evidence: readonly EnadeKeyEvidence[] = [],
  ) {
    super(code);
    this.name = "EnadeAnswerKeyError";
  }
}
const label = (text: string) =>
  text.normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase();
const origin = (line: PdfLine): Provenance => ({
  page: line.page.page,
  bbox: line.bbox,
  method: line.page.method ?? "text",
});
const numberList = (numbers: readonly number[], allowEmpty: boolean) =>
  Array.isArray(numbers) &&
  (allowEmpty || numbers.length > 0) &&
  numbers.length <= 100 &&
  numbers.every(
    (n, i) =>
      Number.isInteger(n) && n >= 1 && n <= 999 && (!i || n > numbers[i - 1]!),
  );
function scopeGuard(scope: EnadeAnswerKeyScope): void {
  if (
    !scope ||
    scope.identityVerified !== true ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(scope.documentId) ||
    !/^[a-f0-9]{64}$/.test(scope.documentSha256) ||
    typeof scope.course !== "string" ||
    !scope.course.trim() ||
    scope.course.length > 100 ||
    !scope.bookletIdentity ||
    !/^\d{2}$/.test(scope.bookletIdentity.code) ||
    !scope.bookletIdentity.label?.trim() ||
    scope.bookletIdentity.label.length > 100 ||
    label(scope.course) !== label(scope.bookletIdentity.label) ||
    !numberList(scope.expectedObjectiveNumbers, false) ||
    !numberList(scope.expectedDiscursiveNumbers, true)
  )
    throw new EnadeAnswerKeyError("scope_unverified");
  if (scope.year !== 2023) throw new EnadeAnswerKeyError("unsupported_year");
  if (scope.finality !== "final")
    throw new EnadeAnswerKeyError("finality_pending");
}
function geometryGuard(pages: PdfLayoutPage[]): void {
  if (
    !pages.length ||
    pages.length > 50 ||
    new Set(pages.map((p) => p.page)).size !== pages.length
  )
    throw new EnadeAnswerKeyError("invalid_geometry");
  for (const page of pages) {
    if (
      !Number.isInteger(page.page) ||
      page.page < 1 ||
      page.page > 500 ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      page.items.length > 100_000
    )
      throw new EnadeAnswerKeyError("invalid_geometry");
    for (const i of page.items)
      if (
        ![i.x, i.y, i.width, i.height].every(Number.isFinite) ||
        i.x < 0 ||
        i.y < 0 ||
        i.width < 0 ||
        i.height <= 0 ||
        (i.text.trim() && i.width === 0) ||
        i.x + i.width > page.width + 0.1 ||
        i.y + i.height > page.height + 0.1
      )
        throw new EnadeAnswerKeyError("invalid_geometry");
  }
}
/** Only the separate, corroborated Item/Gabarito column header establishes cell geometry. */
function tableColumns(lines: PdfLine[]): {
  itemX: number;
  keyX: number;
  top: number;
} {
  const headers = lines.filter((l) => label(l.text) === "ITEM GABARITO");
  if (headers.length !== 1)
    throw new EnadeAnswerKeyError("table_header_missing");
  const h = headers[0]!,
    item = h.items.filter((i) => label(i.text) === "ITEM"),
    key = h.items.filter((i) => label(i.text) === "GABARITO");
  if (
    item.length !== 1 ||
    key.length !== 1 ||
    item[0]!.x + item[0]!.width >= key[0]!.x
  )
    throw new EnadeAnswerKeyError("ambiguous_cells");
  return { itemX: item[0]!.x, keyX: key[0]!.x, top: h.bbox.y + h.bbox.height };
}
/** Parse ENADE2023 FINAL only. Raw key values/retifications remain evidence, never guessed.
 * Headers/enumeration/cell ambiguity throw, retaining private diagnostic rows. */
export function parseEnade2023AnswerKey(
  pages: PdfLayoutPage[],
  scope: EnadeAnswerKeyScope,
): EnadeAnswerKeyResult {
  scopeGuard(scope);
  geometryGuard(pages);
  const entries: AnswerKeyEntry[] = [],
    discursiveRows: EnadeKeyEvidence[] = [],
    retifications: EnadeKeyEvidence[] = [],
    excludedPerceptionRows: EnadeAnswerKeyResult["excludedPerceptionRows"] = [];
  const evidence: EnadeKeyEvidence[] = [];
  const warnings: string[] = [];
  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    const lines = pageLines(page, false);
    const headers = lines.filter((l) => /^GABARITO\b/.test(label(l.text)));
    if (
      headers.length !== 1 ||
      label(headers[0]!.text) !== "GABARITO DEFINITIVO"
    )
      throw new EnadeAnswerKeyError("ambiguous_header", evidence);
    for (const line of lines) {
      const text = label(line.text);
      if (/^ENADE\s*\d{4}$/.test(text) && text.replace(/\D/g, "") !== "2023")
        throw new EnadeAnswerKeyError("ambiguous_header", evidence);
      if (
        /^(?:PROVA|CADERNO|GRUPO)\b/.test(text) &&
        !new RegExp(
          `^(?:PROVA|CADERNO|GRUPO) ${scope.bookletIdentity.code}$`,
        ).test(text)
      )
        throw new EnadeAnswerKeyError("ambiguous_header", evidence);
    }
    const table = tableColumns(lines);
    let perception = false;
    let previous: AnswerKeyEntry | undefined;
    for (const line of lines) {
      if (line.bbox.y <= table.top) continue;
      const text = label(line.text);
      if (/^QUESTION[ÁA]RIO DE PERCEP[ÇC][ÃA]O DA PROVA$/.test(text))
        perception = true;
      if (perception) {
        excludedPerceptionRows.push({
          raw: line.text,
          provenance: origin(line),
        });
        continue;
      }
      const row = /^QUEST[ÃA]O\s+(?:(DISCURSIVA)\s+)?(\d{1,3})\b/.exec(text);
      if (!row) {
        if (/ALTERAD[OA]|RETIFICAD[OA]/.test(text) && previous) {
          retifications.push({
            number: previous.number,
            raw: line.text,
            provenance: origin(line),
          });
          previous.key = null;
          previous.ambiguous = true;
          warnings.push(`retified_key_requires_review:${previous.number}`);
          continue;
        }
        if (/QUEST[ÃA]O|^\d|ANULAD|ALTERAD|RETIFICAD/.test(text))
          throw new EnadeAnswerKeyError("unrecognized_row", evidence);
        continue;
      }
      const number = Number(row[2]);
      // Names and answers must be distinct positioned cells, never substring-sliced from a fused item.
      const left = line.items.filter((i) =>
        /^QUEST[ÃA]O\s+(?:DISCURSIVA\s+)?\d{1,3}$/.test(label(i.text)),
      );
      if (left.length !== 1 || left[0]!.x + left[0]!.width >= table.keyX)
        throw new EnadeAnswerKeyError("ambiguous_cells", evidence);
      const answers = line.items.filter(
        (i) =>
          i !== left[0] && i.x >= table.keyX - Math.max(2, page.width * 0.01),
      );
      if (
        !answers.length ||
        line.items.some((i) => i !== left[0] && !answers.includes(i))
      )
        throw new EnadeAnswerKeyError("ambiguous_cells", evidence);
      const raw = answers.map((i) => i.text).join(" ");
      const record = {
        number,
        raw,
        provenance: origin({
          ...line,
          items: [left[0]!, ...answers],
          bbox: bounds([left[0]!, ...answers]),
        }),
      };
      evidence.push(record);
      if (row[1]) {
        discursiveRows.push(record);
        previous = undefined;
        continue;
      }
      const value = label(raw);
      const annulled =
        value === "ANULADA" || value === "ANULADO" || value === "*";
      const key = /^[A-E]$/.test(value) ? value : null;
      const entry: AnswerKeyEntry = {
        ...record,
        key,
        annulled,
        ambiguous: !annulled && key === null,
      };
      entries.push(entry);
      previous = entry;
      if (/ALTERAD[OA]|RETIFICAD[OA]/.test(value)) retifications.push(record);
      if (entry.ambiguous) warnings.push(`ambiguous_key:${number}`);
    }
  }
  const numbers = entries.map((e) => e.number).sort((a, b) => a - b),
    disc = discursiveRows.map((e) => e.number).sort((a, b) => a - b);
  if (
    JSON.stringify(numbers) !==
      JSON.stringify(scope.expectedObjectiveNumbers) ||
    JSON.stringify(disc) !== JSON.stringify(scope.expectedDiscursiveNumbers)
  )
    throw new EnadeAnswerKeyError("ambiguous_enumeration", evidence);
  return {
    entries,
    warnings,
    group: scope.bookletIdentity.code,
    scope: {
      ...scope,
      bookletIdentity: { ...scope.bookletIdentity },
      expectedObjectiveNumbers: [...scope.expectedObjectiveNumbers],
      expectedDiscursiveNumbers: [...scope.expectedDiscursiveNumbers],
    },
    discursiveRows,
    retifications,
    excludedPerceptionRows,
    structuralNeedsReview:
      entries.some((e) => e.ambiguous) || retifications.length > 0,
  };
}
