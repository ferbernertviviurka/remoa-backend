import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readPdfQuestions } from "./read";
import { createTesseractOcr } from "./ocr";
import { evaluateCorpusDocument, type CorpusGoldDocument } from "./corpus-eval";
import { PdfParserError, type QuestionCandidate } from "./types";
describe.skipIf(process.env.PARSER_CORPUS_EVAL !== "1")(
  "FR31 real authorial PDF corpus and Portuguese OCR",
  () => {
    const root = fileURLToPath(
      new URL(
        "../../../../../../docs/content/questions/corpus/",
        import.meta.url,
      ),
    );
    const label = process.env.PARSER_CORPUS_LABEL;
    if (label && !/^[a-z0-9-]{1,40}$/.test(label))
      throw Error("invalid corpus experiment label");
    const output = resolve(root, "artifacts", ...(label ? [label] : []));
    const dpi = Number(process.env.PARSER_CORPUS_DPI ?? "180");
    if (![180, 300].includes(dpi))
      throw Error("unsupported corpus experiment DPI");
    it("measures all 200 authored records without hiding misses or ambiguous keys", async () => {
      const gold = JSON.parse(
        await readFile(resolve(root, "gold.json"), "utf8"),
      ) as { documents: CorpusGoldDocument[] };
      const manifest = JSON.parse(
        await readFile(resolve(root, "manifest.json"), "utf8"),
      ) as { goldSha256: string; files: { path: string; sha256: string }[] };
      const hash = (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex");
      expect(hash(await readFile(resolve(root, "gold.json")))).toBe(
        manifest.goldSha256,
      );
      expect(gold.documents).toHaveLength(10);
      expect(new Set(gold.documents.map((doc) => doc.exam)).size).toBe(10);
      expect(manifest.files).toHaveLength(20);
      const reports: Array<
        ReturnType<typeof evaluateCorpusDocument> & {
          ocrPages: number[];
          warnings: string[];
          errorCode?: string;
          ocrAttempts: number[];
        }
      > = [];
      const predictions: {
        id: string;
        candidates: QuestionCandidate[];
        removedMargins?: Awaited<
          ReturnType<typeof readPdfQuestions>
        >["removedMargins"];
      }[] = [];
      for (const doc of gold.documents) {
        expect(doc.questions.length).toBeGreaterThanOrEqual(20);
        const exam = await readFile(resolve(root, doc.exam)),
          answerKey = await readFile(resolve(root, doc.answerKey));
        for (const [path, bytes] of [
          [doc.exam, exam],
          [doc.answerKey, answerKey],
        ] as const) {
          expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
          expect(hash(bytes)).toBe(
            manifest.files.find((file) => file.path === path)!.sha256,
          );
        }
        const attempts: number[] = [];
        const adapter = createTesseractOcr({
          language: "por",
          expectedModelSha256: process.env.PARSER_CORPUS_MODEL_SHA256,
          dpi,
          timeoutMs: 60000,
        });
        let parsed: Awaited<ReturnType<typeof readPdfQuestions>>;
        try {
          parsed = await readPdfQuestions(new Uint8Array(exam), {
            answerKeyBytes: new Uint8Array(answerKey),
            group: doc.id,
            ocr: {
              readPage: async (bytes, page) => {
                attempts.push(page.page);
                return adapter.readPage(bytes, page);
              },
            },
          });
        } catch (error) {
          reports.push({
            ...evaluateCorpusDocument(doc, []),
            ocrPages: [],
            ocrAttempts: attempts,
            warnings: ["document_parse_failed"],
            errorCode:
              error instanceof PdfParserError ? error.code : "evaluation_error",
          });
          predictions.push({ id: doc.id, candidates: [] });
          continue;
        }
        expect(
          parsed.candidates.every(
            (candidate) => candidate.status === "staging",
          ),
        ).toBe(true);
        reports.push({
          ...evaluateCorpusDocument(doc, parsed.candidates),
          ocrPages: parsed.layout
            .filter((p) => p.method === "ocr")
            .map((p) => p.page),
          warnings: parsed.warnings,
          ocrAttempts: attempts,
        });
        predictions.push({
          id: doc.id,
          candidates: parsed.candidates,
          removedMargins: parsed.removedMargins,
        });
      }
      const expected = reports.reduce((n, r) => n + r.expected, 0);
      const counts = (key: string) =>
        reports.reduce((n, r) => n + (r.fields[key]?.correct ?? 0), 0);
      const predicted = reports.reduce((n, r) => n + r.predicted, 0);
      const metrics = {
        configuration: { language: "por", dpi, label: label ?? "fast180" },
        expected,
        predicted,
        fields: Object.fromEntries(
          [
            "stem",
            "alternatives",
            "answerKey",
            "annulled",
            "pages",
            "provenanceValid",
            "provenanceBounds",
            "provenanceMethod",
            "visualHandling",
            "exactStructure",
          ].map((key) => [
            key,
            {
              correct: counts(key),
              denominator: expected,
              recall: counts(key) / expected,
              precision: counts(key) / (predicted || 1),
            },
          ]),
        ),
        structuralTarget: 0.95,
        structuralTargetMet: counts("exactStructure") / expected >= 0.95,
        documents: reports,
      };
      await mkdir(output, { recursive: true });
      await writeFile(
        resolve(output, "metrics.json"),
        JSON.stringify(metrics, null, 2) + "\n",
      );
      await writeFile(
        resolve(output, "predictions.json"),
        JSON.stringify(predictions, null, 2) + "\n",
      );
      expect(expected).toBeGreaterThanOrEqual(200);
      expect(reports.filter((report) => report.errorCode)).toEqual([]);
      expect(
        reports.find((r) => r.id === "C03")!.ocrPages.length,
      ).toBeGreaterThan(0);
      expect(
        reports.find((r) => r.id === "C04")!.ocrPages.length,
      ).toBeGreaterThan(0);
      // Quality target is a measured gate in metrics/report, not an assertion that hides a failed report.
    }, 300000);
    it("enforces the independently measured 95 percent exact structural gate", async () => {
      const metrics = JSON.parse(
        await readFile(resolve(output, "metrics.json"), "utf8"),
      ) as { structuralTargetMet: boolean };
      expect(metrics.structuralTargetMet).toBe(true);
    });
  },
);
