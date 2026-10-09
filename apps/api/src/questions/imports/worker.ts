import type { ParserWarningSnapshot } from "./parser-warnings";
import { QUESTION_PDF_OCR_VERSION } from "@remoa/contracts";
import { readPdfLayout } from "@remoa/ai";
import {
  createTesseractOcr,
  parseAnswerKey,
  parseExam,
  renderQuestionCrop,
  type PdfLayoutPage,
  type QuestionCandidate,
} from "../pdf";
import type { SharedContextEvidence } from "../pdf/types";
import { contextEvidencePayload } from "../pdf/shared-context";
import { PARSER_VERSION, sha256 } from "./domain";
import {
  answerKeyPageSelection,
  scopedAnswerKeyLayout,
} from "./answer-key-scope";
export interface ImportJob {
  id: string;
  parserVersion: string;
  ocrVersion: string;
  documentId: string;
  answerKeyDocumentId: string | null;
  objectKey: string;
  answerKeyObjectKey: string | null;
  sha256: string;
  answerKeySha256: string | null;
  answerKeyPages?: number[] | null;
  answerKeyDocumentPages?: number | null;
  booklet: string;
  ocrEnabled: boolean;
  excludedPages: number[];
  budgetCents: number;
  costCents: number;
}
export interface ImportWorkerStore {
  load(id: string): Promise<ImportJob | null>;
  claim(id: string, worker: string): Promise<boolean>;
  cancelled(id: string): Promise<boolean>;
  state(
    id: string,
    status: string,
    total?: number,
    completed?: number,
  ): Promise<void>;
  chunk(
    id: string,
    documentId: string,
    first: number,
    last: number,
  ): Promise<PdfLayoutPage[] | null>;
  saveChunk(
    id: string,
    documentId: string,
    first: number,
    last: number,
    pages: PdfLayoutPage[],
  ): Promise<void>;
  reserveOcr(
    id: string,
    documentId: string,
    page: number,
    cents: number,
  ): Promise<boolean>;
  candidates(
    id: string,
    items: QuestionCandidate[],
    pages: PdfLayoutPage[],
    contexts?: SharedContextEvidence[],
  ): Promise<void>;
  saveParserWarnings(
    id: string,
    snapshot: ParserWarningSnapshot,
  ): Promise<void>;
  failed(id: string, code: string): Promise<void>;
  completed(id: string): Promise<void>;
}
export interface ImportWorkerDeps {
  store: ImportWorkerStore;
  read: (key: string) => Promise<Uint8Array>;
  put: (key: string, bytes: Uint8Array, mime: string) => Promise<void>;
  layout?: (
    bytes: Uint8Array,
    options?: { allowFontMetricOcr?: boolean },
  ) => Promise<{ pages: PdfLayoutPage[] }>;
  ocr?: ReturnType<typeof createTesseractOcr>;
  crop?: typeof renderQuestionCrop;
  exists?: (key: string) => Promise<boolean>;
  ocrPageCostCents?: number;
}
/** Durable chunk data lives in the repository, so cancellation/retries do not depend on one process. */
export async function runQuestionImport(id: string, deps: ImportWorkerDeps) {
  const job = await deps.store.load(id);
  if (!job || !(await deps.store.claim(id, crypto.randomUUID())))
    return { status: "not_claimed" };
  const check = async () => {
    if (await deps.store.cancelled(id)) throw Error("cancelled");
  };
  try {
    await check();
    if (job.parserVersion !== PARSER_VERSION)
      throw Error("parser_version_unsupported_create_new_import");
    if (job.ocrVersion !== QUESTION_PDF_OCR_VERSION)
      throw Error("ocr_version_unsupported_create_new_import");
    const answerKeyPages = answerKeyPageSelection(
      job.answerKeyPages,
      job.answerKeyDocumentId,
      job.answerKeyDocumentPages,
    );
    if (answerKeyPages && (!job.answerKeyObjectKey || !job.answerKeySha256))
      throw Error("answer_key_document_missing");
    if (
      answerKeyPages &&
      (job.answerKeyDocumentPages == null ||
        !Number.isInteger(job.answerKeyDocumentPages) ||
        job.answerKeyDocumentPages < 1 ||
        job.answerKeyDocumentPages > 500)
    )
      throw Error("answer_key_pages_metadata_missing");
    const ocr = deps.ocr ?? createTesseractOcr();
    await deps.store.state(id, "validating");
    const exam = await deps.read(job.objectKey);
    if (sha256(exam) !== job.sha256) throw Error("document_hash_mismatch");
    const layout = deps.layout ?? readPdfLayout;
    const raw = await layout(exam, { allowFontMetricOcr: true });
    if (raw.pages.length > 500) throw Error("page_limit");
    await deps.store.state(id, "extracting", raw.pages.length, 0);
    const extract = async (
      bytes: Uint8Array,
      documentId: string,
      rawPages: PdfLayoutPage[],
      excluded: number[],
      examDocument: boolean,
    ) => {
      const pages: PdfLayoutPage[] = [];
      for (const page of rawPages) {
        await check();
        let cached = await deps.store.chunk(
          id,
          documentId,
          page.page,
          page.page,
        );
        if (!cached) {
          let parsed: PdfLayoutPage;
          if (excluded.includes(page.page))
            parsed = { ...page, items: [], reviewedNonQuestion: true };
          else if (
            page.ocrRequiredReason ||
            page.items
              .map((i) => i.text)
              .join("")
              .replace(/\W/g, "").length < 30
          ) {
            if (!job.ocrEnabled) throw Error("ocr_required");
            await ocr.verifyModel?.();
            await deps.store.state(id, "ocr");
            if (
              !(await deps.store.reserveOcr(
                id,
                documentId,
                page.page,
                deps.ocrPageCostCents ?? 0,
              ))
            )
              throw Error("budget_paused");
            parsed = {
              ...(await ocr.readPage(bytes, page)),
              ...(page.ocrRequiredReason
                ? { ocrRequiredReason: page.ocrRequiredReason }
                : {}),
            };
          } else parsed = { ...page, method: "text" };
          await check();
          cached = [parsed];
          await deps.store.saveChunk(
            id,
            documentId,
            page.page,
            page.page,
            cached,
          );
        }
        pages.push(...cached);
        await deps.store.state(
          id,
          "extracting",
          examDocument ? rawPages.length : undefined,
          examDocument ? pages.length : undefined,
        );
      }
      return pages;
    };
    const pages = await extract(
      exam,
      job.documentId,
      raw.pages,
      job.excludedPages,
      true,
    );
    await check();
    await deps.store.state(id, "matching");
    let key;
    if (job.answerKeyObjectKey && job.answerKeyDocumentId) {
      const bytes = await deps.read(job.answerKeyObjectKey);
      if (sha256(bytes) !== job.answerKeySha256)
        throw Error("answer_key_hash_mismatch");
      const keyLayout = await layout(bytes, { allowFontMetricOcr: true });
      if (keyLayout.pages.length > 500) throw Error("page_limit");
      const selectedKeyLayout = scopedAnswerKeyLayout(
        keyLayout.pages,
        answerKeyPages,
      );
      const keyed = await extract(
        bytes,
        job.answerKeyDocumentId,
        selectedKeyLayout,
        [],
        false,
      );
      try {
        key = parseAnswerKey(keyed, job.booklet);
      } catch (error) {
        await deps.store.saveParserWarnings(id, {
          phase: "key_parse",
          complete: false,
          errorCode: (error as { code?: unknown })?.code ?? "parser_failed",
        });
        throw error;
      }
      await check();
      await deps.store.saveParserWarnings(id, {
        phase: "key_parse",
        complete: false,
        keyWarnings: key.warnings,
      });
    }
    await deps.store.state(id, "segmenting");
    let parsed: ReturnType<typeof parseExam>;
    try {
      parsed = parseExam(pages, key);
    } catch (error) {
      await deps.store.saveParserWarnings(id, {
        phase: "exam_parse",
        complete: false,
        keyWarnings: key?.warnings,
        errorCode: (error as { code?: unknown })?.code ?? "parser_failed",
      });
      throw error;
    }
    await check();
    await deps.store.saveParserWarnings(id, {
      phase: "parsed",
      complete: true,
      examWarnings: parsed.warnings,
      keyWarnings: key?.warnings,
      detectedCandidates: parsed.candidates.length,
      detectedContexts: parsed.sharedContexts?.length ?? 0,
    });
    if (
      parsed.candidates.length > 1000 ||
      (parsed.sharedContexts?.length ?? 0) > 1000
    )
      throw Error("staging_limit_split_document_required");
    if (!parsed.candidates.length && !parsed.sharedContexts?.length)
      throw Error("no_questions_detected");
    for (const context of parsed.sharedContexts ?? []) {
      await check();
      await deps.store.state(id, "segmenting");
      const objectKey = `questions/imports/${id}/contexts/${context.evidenceHash}.json`;
      const evidence = JSON.stringify(contextEvidencePayload(context));
      if (sha256(evidence) !== context.evidenceHash)
        throw Error("context_evidence_hash_mismatch");
      if (!(await deps.exists?.(objectKey)))
        await deps.put(
          objectKey,
          new TextEncoder().encode(evidence),
          "application/json",
        );
      context.evidenceObjectKey = objectKey;
      context.privateImageRefs = [];
      // A region crop remains private even when pdf.js cannot expose embedded image geometry.
      const refs = context.imageRefs.length
        ? context.imageRefs
        : context.provenance;
      for (const [index, ref] of refs.entries()) {
        await check();
        await deps.store.state(id, "segmenting");
        const page = pages.find((p) => p.page === ref.page);
        if (!page) throw Error("missing_image_page");
        const cropKey = `questions/imports/${id}/crops/context-${context.evidenceHash}-${index}.png`;
        if (!(await deps.exists?.(cropKey)))
          await deps.put(
            cropKey,
            await (deps.crop ?? renderQuestionCrop)(exam, page, ref.bbox, 100),
            "image/png",
          );
        const hex = sha256(`${context.evidenceHash}:${index}`).slice(0, 32);
        const imageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
        context.privateImageRefs.push({
          ...ref,
          id: imageId,
          objectKey: cropKey,
        });
      }
    }
    // Keep omission geometry in the versioned private cache, with the unchanged original text.
    // No omitted body text enters job events, analytics, warnings or public candidate DTOs.
    for (const page of pages) {
      const omissions =
        parsed.removedMargins?.filter((ref) => ref.page === page.page) ?? [];
      if (!omissions.length) continue;
      await check();
      await deps.store.state(id, "segmenting");
      page.parserMarginOmissions = omissions.map(
        ({ bbox, method, reason }) => ({ bbox, method, reason }),
      );
      page.parserWarningCodes = [
        ...new Set(omissions.map((ref) => `margin_omitted:${ref.reason}`)),
      ];
      await deps.store.saveChunk(id, job.documentId, page.page, page.page, [
        page,
      ]);
    }
    // Crops are private review evidence, not automatically attached public medical illustrations.
    for (const [candidateIndex, candidate] of parsed.candidates.entries()) {
      await check();
      await deps.store.state(id, "segmenting");
      const refs = [];
      for (const [index, ref] of candidate.imageRefs.entries()) {
        await check();
        await deps.store.state(id, "segmenting");
        const page = pages.find((p) => p.page === ref.page);
        if (!page) throw Error("missing_image_page");
        const objectKey = `questions/imports/${id}/crops/${candidateIndex}-${candidate.originalNumber}-${index}.png`;
        if (!(await deps.exists?.(objectKey))) {
          const png = await (deps.crop ?? renderQuestionCrop)(
            exam,
            page,
            ref.bbox,
            100,
          );
          await deps.put(objectKey, png, "image/png");
        }
        refs.push({ ...ref, objectKey });
      }
      (
        candidate as QuestionCandidate & { privateImageRefs: unknown[] }
      ).privateImageRefs = refs;
    }
    await check();
    await deps.store.candidates(
      id,
      parsed.candidates,
      pages,
      parsed.sharedContexts,
    );
    await deps.store.completed(id);
    return {
      status: "review",
      candidates: parsed.candidates.length,
      parserVersion: PARSER_VERSION,
    };
  } catch (error) {
    const rawCode =
      (error as { code?: unknown })?.code ??
      (error instanceof Error ? error.message : "import_failed");
    // Database/subprocess errors may embed question text or document paths. Persist/log a bounded code only.
    const code =
      typeof rawCode === "string" && /^[a-z_]{3,100}$/.test(rawCode)
        ? rawCode
        : "import_failed";
    await deps.store.failed(id, code);
    return {
      status: code === "cancelled" ? "cancelled" : "failed",
      errorCode: code,
    };
  }
}
