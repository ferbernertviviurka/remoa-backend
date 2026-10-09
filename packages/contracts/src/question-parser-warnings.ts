/** CCR135: bounded private engineering diagnostics, never PDF text or storage URLs. */
import { z } from "zod";
import { idSchema } from "./common";
import { auditEntrySchema } from "./admin";
export const questionParserWarningCodes = [
  "reviewed_non_question_page",
  "margin_omitted",
  "duplicate_number",
  "missing_question",
  "no_questions_detected",
  "unknown_or_ambiguous_key",
  "conflicting_key",
  "no_answer_keys_detected",
  "expected_question_unmatched",
  "segmentation_incomplete",
  "marker_profile_ambiguous",
] as const;
export const questionParserDiagnosticErrors = [
  "group_not_found",
  "ambiguous_key_geometry",
  "parser_failed",
  "no_questions_detected",
  "staging_limit_split_document_required",
] as const;
export const questionParserWarningItemSchema = z
  .object({
    source: z.enum(["exam", "answer_key"]),
    code: z.enum(questionParserWarningCodes),
    count: z.number().int().positive().max(1000000),
    number: z.number().int().min(1).max(999).optional(),
    page: z.number().int().min(1).max(500).optional(),
    reason: z.enum(["known_margin", "repeated_margin"]).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    const numbered = [
      "duplicate_number",
      "missing_question",
      "unknown_or_ambiguous_key",
      "conflicting_key",
      "expected_question_unmatched",
      "segmentation_incomplete",
      "marker_profile_ambiguous",
    ].includes(v.code);
    if (
      numbered !== (v.number !== undefined) ||
      ["reviewed_non_question_page", "margin_omitted"].includes(v.code) !==
        (v.page !== undefined) ||
      (v.code === "margin_omitted") !== (v.reason !== undefined)
    )
      c.addIssue({ code: "custom", message: "warning_shape_invalid" });
  });
const count = z.number().int().min(0).max(1000000),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = z
  .object({
    importId: idSchema,
    parserVersion: z.string().min(1).max(100),
    ocrVersion: z.string().min(1).max(150).nullable(),
    attempt: count,
    planHash: hash,
    availability: z.enum(["available", "not_available"]),
    reason: z.enum(["pending", "not_recorded"]).nullable(),
    phase: z.enum(["key_parse", "exam_parse", "parsed"]).nullable(),
    complete: z.boolean(),
    errorCode: z.enum(questionParserDiagnosticErrors).nullable(),
    detectedCandidates: count.nullable(),
    detectedContexts: count.nullable(),
    total: count.nullable(),
    knownCount: count.nullable(),
    unknownCount: count.nullable(),
    omittedKnownCount: count.nullable(),
    items: z.array(questionParserWarningItemSchema).max(200),
    truncated: z.boolean(),
  })
  .strict();
function validate(v: z.infer<typeof base>, c: z.RefinementCtx) {
  const bad = (message: string) => c.addIssue({ code: "custom", message });
  if (v.availability === "not_available") {
    if (
      !v.reason ||
      v.phase !== null ||
      v.complete ||
      v.errorCode !== null ||
      v.items.length ||
      v.truncated ||
      [
        v.detectedCandidates,
        v.detectedContexts,
        v.total,
        v.knownCount,
        v.unknownCount,
        v.omittedKnownCount,
      ].some((x) => x !== null)
    )
      bad("absent_diagnostics_not_zero");
  } else {
    if (
      v.reason !== null ||
      v.phase === null ||
      v.attempt < 1 ||
      v.knownCount === null ||
      v.unknownCount === null ||
      v.omittedKnownCount === null
    )
      bad("available_diagnostics_required");
    if (
      v.knownCount !== null &&
      v.omittedKnownCount !== null &&
      v.items.reduce((s, i) => s + i.count, 0) + v.omittedKnownCount !==
        v.knownCount
    )
      bad("known_count_mismatch");
    if (v.truncated !== (v.omittedKnownCount ?? 0) > 0)
      bad("truncation_mismatch");
    if (v.complete) {
      if (
        v.phase !== "parsed" ||
        v.errorCode !== null ||
        v.detectedCandidates === null ||
        v.detectedContexts === null ||
        v.total !== (v.knownCount ?? 0) + (v.unknownCount ?? 0)
      )
        bad("complete_diagnostics_required");
    } else if (
      v.total !== null ||
      v.detectedCandidates !== null ||
      v.detectedContexts !== null
    )
      bad("incomplete_totals_unknown");
  }
}
export const questionParserWarningsDataSchema = base.superRefine(validate);
export const questionParserWarningsSchema = base
  .extend({ audit: auditEntrySchema })
  .superRefine(validate);
export type QuestionParserWarningsData = z.infer<
  typeof questionParserWarningsDataSchema
>;
export type QuestionParserWarningItem = z.infer<
  typeof questionParserWarningItemSchema
>;
