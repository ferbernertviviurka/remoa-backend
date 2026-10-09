import type {QUESTION_PDF_PARSER_VERSION} from "@remoa/contracts";
/** Internal staging contracts. Coordinates use the PDF viewport, origin at top-left. */
export interface PdfLayoutItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfLayoutPage {
  page: number;
  width: number;
  height: number;
  items: PdfLayoutItem[];
  images?: PdfBox[];
  /** Private reason retained across OCR and durable caches. */
  ocrRequiredReason?: "font_metrics_nonfinite";
  method?: "text" | "ocr";
  reviewedNonQuestion?: boolean;
  /** Private chunk review evidence; original text items remain intact. Never public DTO/log data. */
  parserMarginOmissions?: {
    bbox: PdfBox;
    method: "text" | "ocr";
    reason: "known_margin" | "repeated_margin";
  }[];
  parserWarningCodes?: string[];
}
export interface Provenance {
  page: number;
  bbox: PdfBox;
  method: "text" | "ocr";
}
export type ParserIssue =
  | "missing_alternatives"
  | "duplicate_alternative"
  | "missing_stem"
  | "number_gap"
  | "duplicate_number"
  | "visual_review_required"
  | "missing_answer_key"
  | "ambiguous_answer_key"
  | "answer_not_in_alternatives"
  | "ocr_used"
  | "shared_context_unresolved"
  | "figure_geometry_unknown"
  | "marker_profile_ambiguous"
  | "segmentation_incomplete";
export interface SharedContextEvidence {
  evidenceHash: string;
  originalText: string;
  rawLayout: PdfLayoutItem[];
  rawPageLayout: PdfLayoutItem[];
  rawPages: {page: number; width: number; height: number; items: PdfLayoutItem[]; images?: PdfBox[]}[];
  declaredNumbers: number[];
  provenance: Provenance[];
  imageRefs: Provenance[];
  issues: ("context_targets_unknown" | "context_boundary_unresolved" | "figure_geometry_unknown")[];
  status: "unresolved";
  evidenceObjectKey?: string;
  privateImageRefs?: (Provenance & { id: string; objectKey: string })[];
}
export interface QuestionCandidate {
  originalNumber: number;
  /** Immutable raw marker; distinct from the full question/crop region. */
  parserMarkerEvidence?: {originalNumber: number; provenance: Provenance};
  stem: string;
  ownStem?: string;
  alternatives: { key: string; text: string }[];
  correctKey: string | null;
  annulled: boolean;
  provenance: Provenance[];
  imageRefs: Provenance[];
  /** This is structural confidence, never medical approval. */
  confidence: { stem: number; alternatives: number; answerKey: number };
  issues: ParserIssue[];
  status: "staging";
}
export interface AnswerKeyEntry {
  number: number;
  key: string | null;
  annulled: boolean;
  ambiguous: boolean;
  raw: string;
  provenance: Provenance;
}
export interface ExamParseResult {
  candidates: QuestionCandidate[];
  sharedContexts?: SharedContextEvidence[];
  warnings: string[];
  pages: number;
  parserVersion: typeof QUESTION_PDF_PARSER_VERSION;
  removedMargins?: (Provenance & {
    text: string;
    reason: "known_margin" | "repeated_margin";
  })[];
}
export interface AnswerKeyResult {
  entries: AnswerKeyEntry[];
  warnings: string[];
  group: string | null;
}
export type PdfErrorCode =
  | "invalid_pdf"
  | "pdf_too_large"
  | "page_limit"
  | "layout_unavailable"
  | "pdf_unreadable"
  | "ocr_unavailable"
  | "ocr_model_mismatch"
  | "ocr_failed"
  | "ocr_timeout"
  | "empty_document"
  | "group_not_found"
  | "ambiguous_key_geometry";
export class PdfParserError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PdfParserError";
  }
}
export interface OcrAdapter {
  verifyModel?(): Promise<void>;
  readPage(bytes: Uint8Array, page: PdfLayoutPage): Promise<PdfLayoutPage>;
}
export interface ReadPdfOptions {
  maxBytes?: number;
  maxPages?: number;
  reviewedNonQuestionPages?: number[];
  ocr?: OcrAdapter;
  allowFontMetricOcr?: boolean;
  readLayout?: (
    bytes: Uint8Array,
    options?: { allowFontMetricOcr?: boolean },
  ) => Promise<PdfLayoutPage[] | { pages: PdfLayoutPage[] }>;
}

/** Private structural codes only; never contain stems or alternative text. */
export type PdfStructuralWarning =
 | `expected_question_unmatched:${number}`
 | `duplicate_number:${number}`
 | `segmentation_incomplete:${number}`
 | `marker_profile_ambiguous:${number}`;
