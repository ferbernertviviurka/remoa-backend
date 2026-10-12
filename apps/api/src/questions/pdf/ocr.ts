import { createHash } from "node:crypto";
import {
  QUESTION_PDF_OCR_DPI,
  QUESTION_PDF_OCR_MODEL_SHA256,
} from "@remoa/contracts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PdfParserError,
  type OcrAdapter,
  type PdfLayoutPage,
  type PdfLayoutItem,
} from "./types";
import { bounds } from "./layout";
const execute = promisify(execFile);
export interface OcrOptions {
  language?: string;
  timeoutMs?: number;
  dpi?: number;
  /** Controlled engineering QA only; production always requires the fixed best model. */
  expectedModelSha256?: string;
}
/** TSV word rows -> layout items. A TSV line keeps its OCR identity (baseline/column segmentation), but it is
 * split into separate items at column-sized gaps between REAL word boxes (D-1813): tesseract often reports a grid
 * row "B) ... D) ..." as one line. Gap evidence: wider than 1.5x the line's median word height and than 3x its
 * median inter-word gap (or 3 word heights). Never a regex over joined text, never estimated glyph widths. */
export function ocrTsvItems(tsv: string, scale: number): PdfLayoutItem[] {
  const lineGroups = new Map<string, PdfLayoutItem[]>();
  for (const row of tsv.split("\n").slice(1)) {
    const fields = row.split("\t");
    if (fields.length < 12 || fields[0] !== "5" || !fields[11]!.trim()) continue;
    const [x = 0, y = 0, width = 0, height = 0, confidence = 0] = fields.slice(6, 11).map(Number);
    if ([x, y, width, height, confidence].some((v) => !Number.isFinite(v))) continue;
    const lineId = fields.slice(1, 5).join(":");
    const group = lineGroups.get(lineId) ?? [];
    group.push({ text: fields.slice(11).join("\t"), x: x * scale, y: y * scale, width: width * scale, height: height * scale });
    lineGroups.set(lineId, group);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  // Sorting glyph-top y independently can move a short word like “o” after its sentence: keep TSV line order.
  return [...lineGroups.values()].flatMap((line) => {
    const words = [...line].sort((a, b) => a.x - b.x);
    const gaps = words.slice(1).map((w, i) => w.x - words[i]!.x - words[i]!.width);
    const height = median(words.map((w) => w.height));
    // Column gutter: never under 1.5 word heights; beyond 3 heights it is a gutter even when most gaps are gutters
    // (a row of five short options has more gutters than word spaces).
    const threshold = Math.max(1.5 * height, Math.min(3 * median(gaps), 3 * height));
    const parts: PdfLayoutItem[][] = [[]];
    words.forEach((w, i) => {
      if (i > 0 && gaps[i - 1]! > threshold) parts.push([]);
      parts.at(-1)!.push(w);
    });
    return parts.map((part) => ({ text: part.map((w) => w.text).join(" "), ...bounds(part) }));
  });
}
/** Production workers need Poppler and Tesseract + the selected language data. No shell interpolation. */
export function createTesseractOcr(options: OcrOptions = {}): OcrAdapter {
  const language = options.language ?? "por",
    timeout = options.timeoutMs ?? 60000,
    dpi = options.dpi ?? QUESTION_PDF_OCR_DPI;
  if (
    !/^[a-z_+]{3,30}$/.test(language) ||
    timeout < 100 ||
    timeout > 120000 ||
    dpi < 72 ||
    dpi > 300
  )
    throw new PdfParserError("ocr_failed", "Invalid OCR configuration");
  const expectedModelSha256 =
    options.expectedModelSha256 ?? QUESTION_PDF_OCR_MODEL_SHA256;
  if (
    !/^[a-f0-9]{64}$/.test(expectedModelSha256) ||
    (expectedModelSha256 !== QUESTION_PDF_OCR_MODEL_SHA256 &&
      !["test", "development"].includes(process.env.NODE_ENV ?? ""))
  )
    throw new PdfParserError(
      "ocr_model_mismatch",
      "OCR model override is restricted to engineering QA",
    );
  const modelPrefix =
    process.env.TESSDATA_PREFIX || "/opt/remoa-question-tessdata";
  let modelCheck: Promise<void> | undefined;
  const verifyModel = () =>
    (modelCheck ??= (async () => {
      let model: Uint8Array;
      try {
        model = await readFile(join(modelPrefix, `${language}.traineddata`));
      } catch {
        throw new PdfParserError(
          "ocr_unavailable",
          "Pinned OCR language data is unavailable",
        );
      }
      if (
        createHash("sha256").update(model).digest("hex") !== expectedModelSha256
      )
        throw new PdfParserError(
          "ocr_model_mismatch",
          "OCR model does not match the pinned version",
        );
    })());
  return {
    verifyModel,
    async readPage(bytes, page) {
      if (
        page.page < 1 ||
        !Number.isInteger(page.page) ||
        page.width <= 0 ||
        page.height <= 0 ||
        !Number.isFinite(page.width * page.height) ||
        page.width * page.height * (dpi / 72) ** 2 > 20_000_000
      )
        throw new PdfParserError(
          "ocr_failed",
          "OCR page exceeds geometry/pixel limits",
        );
      await verifyModel();
      const directory = await mkdtemp(join(tmpdir(), "remoa-question-ocr-"));
      try {
        const input = join(directory, "input.pdf"),
          output = join(directory, "page");
        await writeFile(input, bytes, { mode: 0o600 });
        await execute(
          "pdftoppm",
          [
            "-f",
            String(page.page),
            "-l",
            String(page.page),
            "-singlefile",
            "-r",
            String(dpi),
            "-png",
            input,
            output,
          ],
          { timeout, maxBuffer: 1024 * 1024 },
        );
        const { stdout } = await execute(
          "tesseract",
          [`${output}.png`, "stdout", "-l", language, "--psm", "3", "tsv"],
          {
            timeout,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, TESSDATA_PREFIX: modelPrefix },
          },
        );
        const items = ocrTsvItems(stdout, 72 / dpi);
        if (!items.length)
          throw new PdfParserError(
            "ocr_failed",
            "OCR produced no readable text",
          );
        return { ...page, items, method: "ocr" };
      } catch (error) {
        if (error instanceof PdfParserError) throw error;
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT")
          throw new PdfParserError(
            "ocr_unavailable",
            "OCR worker requires pdftoppm and tesseract executables",
          );
        if (e.killed)
          throw new PdfParserError(
            "ocr_timeout",
            "OCR page exceeded its time budget",
          );
        throw new PdfParserError(
          "ocr_failed",
          "OCR/rendering failed; verify installed language data and input PDF",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
/** Render the exact review crop. Persistence/access-control belong to the admin job, never this parser. */
export async function renderQuestionCrop(
  bytes: Uint8Array,
  page: PdfLayoutPage,
  bbox: { x: number; y: number; width: number; height: number },
  dpi = 120,
): Promise<Uint8Array> {
  if (
    page.page < 1 ||
    !Number.isInteger(page.page) ||
    dpi < 72 ||
    dpi > 300 ||
    Object.values(bbox).some((v) => !Number.isFinite(v) || v < 0) ||
    !bbox.width ||
    !bbox.height ||
    bbox.x + bbox.width > page.width + 1 ||
    bbox.y + bbox.height > page.height + 1 ||
    bbox.width * bbox.height * (dpi / 72) ** 2 > 20_000_000
  )
    throw new PdfParserError("invalid_pdf", "Invalid crop coordinates");
  const directory = await mkdtemp(join(tmpdir(), "remoa-question-crop-"));
  try {
    const input = join(directory, "input.pdf"),
      output = join(directory, "crop");
    await writeFile(input, bytes, { mode: 0o600 });
    const scale = dpi / 72;
    await execute(
      "pdftoppm",
      [
        "-f",
        String(page.page),
        "-l",
        String(page.page),
        "-singlefile",
        "-r",
        String(dpi),
        "-x",
        String(Math.floor(bbox.x * scale)),
        "-y",
        String(Math.floor(bbox.y * scale)),
        "-W",
        String(Math.ceil(bbox.width * scale)),
        "-H",
        String(Math.ceil(bbox.height * scale)),
        "-png",
        input,
        output,
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    return new Uint8Array(await readFile(`${output}.png`));
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean };
    throw new PdfParserError(
      e.code === "ENOENT"
        ? "ocr_unavailable"
        : e.killed
          ? "ocr_timeout"
          : "ocr_failed",
      "Review crop rendering failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
