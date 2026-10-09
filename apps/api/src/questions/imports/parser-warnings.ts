import {
  idSchema,
  questionParserWarningsDataSchema,
  questionParserDiagnosticErrors,
  type QuestionParserWarningsData,
  type QuestionParserWarningItem,
} from "@remoa/contracts";
import { sha256 } from "./domain";
export const WARNING_BYTES = 128 * 1024;
export const WARNING_PHASES = ["parsed", "exam_parse", "key_parse"] as const;
export interface DiagnosticPlan {
  importId: string;
  parserVersion: string;
  ocrVersion: string | null;
  documentId: string;
  documentSha256: string;
  answerKeyDocumentId: string | null;
  answerKeySha256: string | null;
  booklet: string;
  excludedPages: number[];
  answerKeyPages: number[] | null;
  ocrEnabled: boolean;
}
export interface OwnedDiagnosticPlan extends DiagnosticPlan {
  attempt: number;
  workerId: string | null;
  leaseUntil: Date | null;
  status: string;
}
export interface ParserWarningSnapshot {
  phase: "key_parse" | "exam_parse" | "parsed";
  examWarnings?: string[];
  keyWarnings?: string[];
  complete: boolean;
  errorCode?: unknown;
  detectedCandidates?: number;
  detectedContexts?: number;
}
export function warningPlanHash(p: DiagnosticPlan) {
  return sha256(
    JSON.stringify({
      parserVersion: p.parserVersion,
      ocrVersion: p.ocrVersion,
      documentId: p.documentId,
      documentSha256: p.documentSha256,
      answerKeyDocumentId: p.answerKeyDocumentId,
      answerKeySha256: p.answerKeySha256,
      booklet: p.booklet,
      excludedPages: [...p.excludedPages].sort((a, b) => a - b),
      answerKeyPages:
        p.answerKeyPages === null
          ? null
          : [...p.answerKeyPages].sort((a, b) => a - b),
      ocrEnabled: p.ocrEnabled,
      extractionPolicy: "font-metrics-ocr-v1",
    }),
  );
}
export function warningArtifactKey(
  p: DiagnosticPlan,
  attempt: number,
  phase: ParserWarningSnapshot["phase"],
) {
  if (
    !idSchema.safeParse(p.importId).success ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    throw Error("warning_plan_invalid");
  return `questions/imports/${p.importId}/diagnostics/warnings-v1/${warningPlanHash(p)}/attempt-${attempt}/${phase}.json`;
}
export function summarizeWarnings(
  p: DiagnosticPlan,
  attempt: number,
  s: ParserWarningSnapshot,
): QuestionParserWarningsData {
  const groups = new Map<string, QuestionParserWarningItem>();
  let unknownCount = 0;
  for (const source of ["exam", "answer_key"] as const)
    for (const raw of (source === "exam" ? s.examWarnings : s.keyWarnings) ??
      []) {
      let item: Omit<QuestionParserWarningItem, "count"> | null = null,
        m: RegExpMatchArray | null;
      if (
        (m = raw.match(
          /^(duplicate_number|missing_question|unknown_or_ambiguous_key|conflicting_key|expected_question_unmatched|segmentation_incomplete|marker_profile_ambiguous):([1-9]\d{0,2})$/,
        ))
      )
        item = {
          source,
          code: m[1] as QuestionParserWarningItem["code"],
          number: Number(m[2]),
        };
      else if (
        (m = raw.match(/^reviewed_non_question_page:([1-9]\d{0,2})$/)) &&
        Number(m[1]) <= 500
      )
        item = {
          source,
          code: "reviewed_non_question_page",
          page: Number(m[1]),
        };
      else if (
        (m = raw.match(
          /^margin_omitted:([1-9]\d{0,2}):(known_margin|repeated_margin)$/,
        )) &&
        Number(m[1]) <= 500
      )
        item = {
          source,
          code: "margin_omitted",
          page: Number(m[1]),
          reason: m[2] as "known_margin" | "repeated_margin",
        };
      else if (
        raw === "no_questions_detected" ||
        raw === "no_answer_keys_detected"
      )
        item = { source, code: raw };
      if (!item) {
        unknownCount++;
        continue;
      }
      const k = JSON.stringify(item),
        previous = groups.get(k);
      groups.set(k, { ...item, count: (previous?.count ?? 0) + 1 });
    }
  const all = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v),
    items = all.slice(0, 200),
    knownCount = all.reduce((n, v) => n + v.count, 0),
    omittedKnownCount = all.slice(200).reduce((n, v) => n + v.count, 0);
  const error =
    s.errorCode == null
      ? null
      : questionParserDiagnosticErrors.includes(s.errorCode as never)
        ? (s.errorCode as QuestionParserWarningsData["errorCode"])
        : "parser_failed";
  return questionParserWarningsDataSchema.parse({
    importId: p.importId,
    parserVersion: p.parserVersion,
    ocrVersion: p.ocrVersion,
    attempt,
    planHash: warningPlanHash(p),
    availability: "available",
    reason: null,
    phase: s.phase,
    complete: s.complete,
    errorCode: error,
    detectedCandidates: s.complete ? s.detectedCandidates : null,
    detectedContexts: s.complete ? s.detectedContexts : null,
    total: s.complete ? knownCount + unknownCount : null,
    knownCount,
    unknownCount,
    omittedKnownCount,
    items,
    truncated: omittedKnownCount > 0,
  });
}
export function absentWarnings(
  p: DiagnosticPlan,
  attempt: number,
  status: string,
): QuestionParserWarningsData {
  return questionParserWarningsDataSchema.parse({
    importId: p.importId,
    parserVersion: p.parserVersion,
    ocrVersion: p.ocrVersion,
    attempt,
    planHash: warningPlanHash(p),
    availability: "not_available",
    reason: [
      "queued",
      "validating",
      "extracting",
      "ocr",
      "segmenting",
      "matching",
    ].includes(status)
      ? "pending"
      : "not_recorded",
    phase: null,
    complete: false,
    errorCode: null,
    detectedCandidates: null,
    detectedContexts: null,
    total: null,
    knownCount: null,
    unknownCount: null,
    omittedKnownCount: null,
    items: [],
    truncated: false,
  });
}
export interface WarningStorage {
  head(key: string): Promise<{ size: number; mime: string } | null>;
  read(key: string, maxBytes: number): Promise<Uint8Array>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}
export async function readWarningArtifact(
  p: DiagnosticPlan,
  attempt: number,
  status: string,
  storage: WarningStorage,
) {
  if (attempt < 1) return absentWarnings(p, attempt, status);
  for (const phase of WARNING_PHASES) {
    const key = warningArtifactKey(p, attempt, phase),
      head = await storage.head(key);
    if (!head) continue;
    if (
      head.size < 2 ||
      head.size > WARNING_BYTES ||
      head.mime !== "application/json"
    )
      throw Error("warning_artifact_invalid");
    const bytes = await storage.read(key, WARNING_BYTES);
    if (bytes.length !== head.size) throw Error("warning_artifact_invalid");
    const dto = questionParserWarningsDataSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      dto.importId !== p.importId ||
      dto.attempt !== attempt ||
      dto.planHash !== warningPlanHash(p) ||
      dto.phase !== phase ||
      dto.parserVersion !== p.parserVersion ||
      dto.ocrVersion !== p.ocrVersion
    )
      throw Error("warning_plan_mismatch");
    return dto;
  }
  return absentWarnings(p, attempt, status);
}
export async function persistWarningArtifact(
  p: OwnedDiagnosticPlan,
  token: string,
  s: ParserWarningSnapshot,
  owned: () => Promise<OwnedDiagnosticPlan>,
  storage: WarningStorage,
  onCleanupPending?: () => void,
) {
  const assert = (r: OwnedDiagnosticPlan) => {
    if (r.status === "cancelled") throw Error("cancelled");
    if (
      !token ||
      r.workerId !== token ||
      !r.leaseUntil ||
      r.leaseUntil.getTime() <= Date.now() ||
      r.attempt !== p.attempt ||
      warningPlanHash(r) !== warningPlanHash(p)
    )
      throw Error("lease_lost");
  };
  assert(p);
  assert(await owned());
  const key = warningArtifactKey(p, p.attempt, s.phase),
    body = new TextEncoder().encode(
      JSON.stringify(summarizeWarnings(p, p.attempt, s)),
    );
  if (body.length > WARNING_BYTES) throw Error("warning_byte_limit");
  const existing = await storage.head(key);
  let created = false;
  try {
    if (existing) {
      const prior = await storage.read(key, WARNING_BYTES);
      if (sha256(prior) !== sha256(body))
        throw Error("warning_immutable_conflict");
    } else {
      created = true;
      await storage.put(key, body);
    }
    const head = await storage.head(key);
    if (
      !head ||
      head.size !== body.length ||
      head.mime !== "application/json" ||
      sha256(await storage.read(key, WARNING_BYTES)) !== sha256(body)
    )
      throw Error("warning_artifact_invalid");
    assert(await owned());
  } catch (error) {
    if (created) {
      try {
        const r = await owned();
        /* Never delete a receipt that a currently active owner may be committing. */ if (
          r.attempt !== p.attempt ||
          r.status === "cancelled" ||
          r.workerId === token
        )
          await storage.remove(key);
        else onCleanupPending?.();
      } catch {
        onCleanupPending?.(); /* Own attempt orphan retained; never delete another writer's key. */
      }
    }
    throw error;
  }
}
