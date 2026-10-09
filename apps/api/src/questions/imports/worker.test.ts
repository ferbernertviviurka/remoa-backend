import { QUESTION_PDF_OCR_VERSION } from "@remoa/contracts";
import { describe, it, expect, vi } from "vitest";
import {
  runQuestionImport,
  type ImportJob,
  type ImportWorkerStore,
} from "./worker";
import { sha256, PARSER_VERSION } from "./domain";
import { parseAnswerKey, type PdfLayoutPage } from "../pdf";
const bytes = new TextEncoder().encode("%PDF-1.7 synthetic");
const page = (n: number, scan = false): PdfLayoutPage => ({
  page: n,
  width: 600,
  height: 800,
  items: scan
    ? []
    : [
        "Questão " + n,
        "Enunciado sintético extenso suficiente para extração determinística",
        "(A) Primeiro texto",
        "(B) Segundo texto",
      ].map((text, i) => ({
        text,
        x: 10,
        y: 50 + i * 20,
        width: 200,
        height: 12,
      })),
});
function harness() {
  let cancelled = false,
    failPage = 0,
    cost = 0;
  const cache = new Map<string, PdfLayoutPage[]>(),
    reserved = new Set<string>();
  const saved: unknown[] = [];
  const job: ImportJob = {
    id: "job",
    parserVersion: PARSER_VERSION,
    ocrVersion: QUESTION_PDF_OCR_VERSION,
    documentId: "doc",
    answerKeyDocumentId: null,
    objectKey: "exam",
    answerKeyObjectKey: null,
    sha256: sha256(bytes),
    answerKeySha256: null,
    booklet: "AD1",
    ocrEnabled: true,
    excludedPages: [],
    budgetCents: 100,
    costCents: 0,
  };
  const store: ImportWorkerStore = {
    load: async () => job,
    claim: async () => true,
    cancelled: async () => cancelled,
    state: vi.fn(async () => {}),
    chunk: async (_, d, p) => cache.get(d + p) ?? null,
    saveChunk: async (_, d, p, _last, pages) => {
      cache.set(d + p, pages);
    },
    reserveOcr: async (_, d, p, c) => {
      if (!reserved.has(d + p)) {
        if (cost + c > job.budgetCents) return false;
        reserved.add(d + p);
        cost += c;
      }
      return true;
    },
    candidates: async (_, items) => {
      saved.push(...items);
    },
    saveParserWarnings: vi.fn(async () => {}),
    completed: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const ocr = {
    readPage: vi.fn(async (_: Uint8Array, p: PdfLayoutPage) => {
      if (p.page === failPage) throw Error("crash");
      return page(p.page);
    }),
  };
  return {
    job,
    store,
    ocr,
    cache,
    saved,
    get cost() {
      return cost;
    },
    cancel() {
      cancelled = true;
    },
    fail(n: number) {
      failPage = n;
    },
  };
}
describe("durable import worker", () => {
  it("persists key and exam warnings before zero-candidate failure, without confusing answer keys with question count", async () => {
    const h = harness(),
      kb = new TextEncoder().encode("%PDF key"),
      events: string[] = [];
    Object.assign(h.job, {
      answerKeyDocumentId: "key-doc",
      answerKeyObjectKey: "key",
      answerKeySha256: sha256(kb),
      booklet: "",
    });
    h.store.saveParserWarnings = vi.fn(async (_, s) => {
      events.push(s.phase);
    });
    h.store.failed = vi.fn(async () => {
      events.push("failed");
    });
    const layout = async (b: Uint8Array) => ({
      pages:
        b === kb
          ? [
              {
                page: 1,
                width: 600,
                height: 800,
                items: [
                  "GABARITO OFICIAL SINTÉTICO SEM CONTEÚDO MÉDICO",
                  "1 A",
                  "2 B",
                ].map((text, i) => ({
                  text,
                  x: 20,
                  y: 50 + i * 25,
                  width: 60,
                  height: 12,
                })),
              },
            ]
          : [
              {
                page: 1,
                width: 600,
                height: 800,
                items: [
                  {
                    text: "Original metadata without question markers",
                    x: 20,
                    y: 80,
                    width: 300,
                    height: 12,
                  },
                ],
              },
            ],
    });
    const r = await runQuestionImport("job", {
      store: h.store,
      read: async (k) => (k === "key" ? kb : bytes),
      layout,
      put: async () => {},
      ocr: h.ocr,
    });
    expect(r.errorCode).toBe("no_questions_detected");
    expect(events).toEqual(["key_parse", "parsed", "failed"]);
    expect(h.store.saveParserWarnings).toHaveBeenLastCalledWith(
      "job",
      expect.objectContaining({
        complete: true,
        detectedCandidates: 0,
        examWarnings: expect.arrayContaining([
          "expected_question_unmatched:1",
          "expected_question_unmatched:2",
          "no_questions_detected",
        ]),
      }),
    );
    expect(h.store.completed).not.toHaveBeenCalled();
  });
  it("persists a typed key failure with unknown totals before recording failure, never clinical error messages", async () => {
    const h = harness(),
      kb = new TextEncoder().encode("%PDF key");
    Object.assign(h.job, {
      answerKeyDocumentId: "key-doc",
      answerKeyObjectKey: "key",
      answerKeySha256: sha256(kb),
      booklet: "B",
    });
    await runQuestionImport("job", {
      store: h.store,
      read: async (k) => (k === "key" ? kb : bytes),
      layout: async (b) => ({
        pages:
          b === kb
            ? [
                {
                  page: 1,
                  width: 600,
                  height: 800,
                  items: ["PROVA A", "1 A"].map((text, i) => ({
                    text,
                    x: 20,
                    y: 50 + i * 25,
                    width: 100,
                    height: 12,
                  })),
                },
              ]
            : [page(1)],
      }),
      put: async () => {},
      ocr: h.ocr,
    });
    expect(h.store.saveParserWarnings).toHaveBeenCalledWith("job", {
      phase: "key_parse",
      complete: false,
      errorCode: "group_not_found",
    });
    expect(h.saved).toHaveLength(0);
  });
  it("does not commit candidates or complete the import when diagnostic storage fails", async () => {
    const h = harness();
    h.store.saveParserWarnings = vi.fn(async () => {
      throw Error("warning_artifact_invalid");
    });
    const r = await runQuestionImport("job", {
      store: h.store,
      read: async () => bytes,
      layout: async () => ({ pages: [page(1)] }),
      put: async () => {},
      ocr: h.ocr,
    });
    expect(r.errorCode).toBe("warning_artifact_invalid");
    expect(h.saved).toHaveLength(0);
    expect(h.store.completed).not.toHaveBeenCalled();
  });

  it("scopes key page 3 before OCR/cache/reservation, preserves original numbering and reuses only selected chunks on retry", async () => {
    const h = harness(),
      keyBytes = new TextEncoder().encode("%PDF-1.7 synthetic key");
    Object.assign(h.job, {
      answerKeyDocumentId: "key-doc",
      answerKeyObjectKey: "key",
      answerKeySha256: sha256(keyBytes),
      answerKeyPages: [3],
      answerKeyDocumentPages: 4,
    });
    h.ocr.readPage.mockImplementation(async (_bytes, p) => ({
      ...p,
      items: ["PROVA AD1", "1 A"].map((text, i) => ({
        text,
        x: 20,
        y: 30 + i * 30,
        width: 100,
        height: 12,
      })),
    }));
    const chunk = vi.spyOn(h.store, "chunk"),
      reserve = vi.spyOn(h.store, "reserveOcr");
    const deps = {
      store: h.store,
      read: async (k: string) => (k === "key" ? keyBytes : bytes),
      layout: async (b: Uint8Array) => ({
        pages:
          b === keyBytes
            ? [page(1, true), page(3, true), page(4, true)]
            : [page(1)],
      }),
      ocr: h.ocr,
      ocrPageCostCents: 7,
      put: async () => {},
    };
    expect(await runQuestionImport("job", deps)).toMatchObject({
      status: "review",
      candidates: 1,
    });
    expect(h.ocr.readPage).toHaveBeenCalledOnce();
    expect(h.ocr.readPage.mock.calls[0]![1].page).toBe(3);
    expect(h.cost).toBe(7);
    expect((h.saved[0] as { correctKey: string }).correctKey).toBe("A");
    expect([...h.cache.keys()]).toEqual(["doc1", "key-doc3"]);
    expect(
      parseAnswerKey(h.cache.get("key-doc3")!, "AD1").entries[0]!.provenance
        .page,
    ).toBe(3);
    expect(reserve).toHaveBeenCalledWith("job", "key-doc", 3, 7);
    expect(
      chunk.mock.calls
        .filter((call) => call[1] === "key-doc")
        .map((call) => call[2]),
    ).toEqual([3]);
    await runQuestionImport("job", deps);
    expect(h.ocr.readPage).toHaveBeenCalledOnce();
    expect(h.cost).toBe(7);
  });
  it("different explicit key pages produce different final keys without consulting the unselected pages", async () => {
    for (const selected of [3, 4]) {
      const h = harness(),
        keyBytes = new TextEncoder().encode("%PDF-1.7 synthetic key");
      Object.assign(h.job, {
        answerKeyDocumentId: "key-doc",
        answerKeyObjectKey: "key",
        answerKeySha256: sha256(keyBytes),
        answerKeyPages: [selected],
        answerKeyDocumentPages: 4,
      });
      h.ocr.readPage.mockImplementation(async (_bytes, p) => ({
        ...p,
        items: ["PROVA AD1", `1 ${p.page === 3 ? "A" : "B"}`].map(
          (text, i) => ({
            text,
            x: 20,
            y: 30 + i * 30,
            width: 100,
            height: 12,
          }),
        ),
      }));
      const r = await runQuestionImport("job", {
        store: h.store,
        read: async (k: string) => (k === "key" ? keyBytes : bytes),
        layout: async (b: Uint8Array) => ({
          pages: b === keyBytes ? [page(3, true), page(4, true)] : [page(1)],
        }),
        ocr: h.ocr,
        ocrPageCostCents: 7,
        put: async () => {},
      });
      expect(r.status).toBe("review");
      expect((h.saved[0] as { correctKey: string }).correctKey).toBe(
        selected === 3 ? "A" : "B",
      );
      expect(h.ocr.readPage.mock.calls.map((call) => call[1].page)).toEqual([
        selected,
      ]);
      expect(h.cost).toBe(7);
    }
  });
  it("fails malformed or missing key scopes before downloads, cache or OCR costs", async () => {
    for (const patch of [
      { answerKeyPages: [3] },
      {
        answerKeyPages: [3],
        answerKeyDocumentId: "key-doc",
        answerKeyDocumentPages: 2,
        answerKeyObjectKey: "key",
      },
      {
        answerKeyPages: [3],
        answerKeyDocumentId: "key-doc",
        answerKeyDocumentPages: null,
        answerKeyObjectKey: "key",
        answerKeySha256: sha256(bytes),
      },
    ]) {
      const h = harness();
      Object.assign(h.job, patch);
      const read = vi.fn(async () => bytes),
        chunk = vi.spyOn(h.store, "chunk");
      const r = await runQuestionImport("job", {
        store: h.store,
        read,
        ocr: h.ocr,
        put: async () => {},
      });
      expect(r.status).toBe("failed");
      expect(read).not.toHaveBeenCalled();
      expect(chunk).not.toHaveBeenCalled();
      expect(h.ocr.readPage).not.toHaveBeenCalled();
      expect(h.cost).toBe(0);
    }
  });

  it("persists orphan context evidence and crop even when no candidate is detected, with durable retry keys", async () => {
    const h = harness();
    const contextPage = page(1);
    contextPage.items = [
      "TEXTO PARA QUESTÕES 7 E 8",
      "Não substituir 2 kg por 2 mg.",
      "1. Lista interna.",
      "2. Lista interna.",
    ].map((text, i) => ({
      text,
      x: 20,
      y: 100 + i * 20,
      width: 250,
      height: 12,
    }));
    const save = vi.fn<ImportWorkerStore["candidates"]>(async () => {});
    h.store.candidates = save;
    const objects = new Map<string, Uint8Array>();
    const put = vi.fn(async (k: string, b: Uint8Array) => {
      objects.set(k, b);
    });
    const crop = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
    const deps = {
      store: h.store,
      read: async () => bytes,
      layout: async () => ({ pages: [contextPage] }),
      put,
      crop,
      exists: async (k: string) => objects.has(k),
    };
    const r = await runQuestionImport("job", deps);
    expect(r).toMatchObject({ status: "review", candidates: 0 });
    expect(h.store.completed).toHaveBeenCalledOnce();
    const call = save.mock.calls[0]!;
    const context = call[3]![0]!;
    expect(context.originalText).toContain("Não substituir 2 kg por 2 mg.");
    expect(context.evidenceObjectKey).toMatch(
      /^questions\/imports\/job\/contexts\//,
    );
    expect(sha256(objects.get(context.evidenceObjectKey!)!)).toBe(
      context.evidenceHash,
    );
    expect(context.privateImageRefs).toHaveLength(1);
    await runQuestionImport("job", deps);
    expect(put).toHaveBeenCalledTimes(2);
    expect(crop).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("does not complete context review after evidence storage failure and honors cancellation before crop", async () => {
    const h = harness();
    const p = page(1);
    p.items = [
      {
        text: "TEXTO PARA QUESTÕES 7 E 8",
        x: 20,
        y: 100,
        width: 200,
        height: 12,
      },
      { text: "Não alterar 2 kg.", x: 20, y: 120, width: 200, height: 12 },
    ];
    const crop = vi.fn(async () => new Uint8Array([1]));
    const put = vi.fn(async () => {
      throw Error("storage_unavailable");
    });
    await runQuestionImport("job", {
      store: h.store,
      read: async () => bytes,
      layout: async () => ({ pages: [p] }),
      put,
      crop,
    });
    expect(h.store.completed).not.toHaveBeenCalled();
    expect(crop).not.toHaveBeenCalled();
    const h2 = harness();
    await runQuestionImport("job", {
      store: h2.store,
      read: async () => bytes,
      layout: async () => ({ pages: [p] }),
      put: async () => {
        h2.cancel();
      },
      crop,
    });
    expect(h2.store.completed).not.toHaveBeenCalled();
    expect(crop).not.toHaveBeenCalled();
  });

  it("font-metric pages use explicit OCR policy and keep private evidence through durable cache/retry", async () => {
    const h = harness(),
      flagged = {
        ...page(1, true),
        ocrRequiredReason: "font_metrics_nonfinite" as const,
      };
    const layout = vi.fn(async () => ({ pages: [flagged] }));
    const deps = {
      store: h.store,
      read: async () => bytes,
      layout,
      put: async () => {},
      ocr: h.ocr,
      ocrPageCostCents: 5,
    };
    await runQuestionImport("job", deps);
    expect(layout).toHaveBeenCalledWith(bytes, { allowFontMetricOcr: true });
    expect(h.cache.get("doc1")?.[0]).toMatchObject({
      ocrRequiredReason: "font_metrics_nonfinite",
    });
    expect(h.cost).toBe(5);
    expect(h.ocr.readPage).toHaveBeenCalledOnce();
    await runQuestionImport("job", deps);
    expect(h.ocr.readPage).toHaveBeenCalledOnce();
    expect(h.cost).toBe(5);
  });
  it("reserves each of 37 font-metric pages once and resumes all durable pages in a new invocation", async () => {
    const h = harness();
    const flagged = Array.from({ length: 37 }, (_, i) => ({
      ...page(i + 1, true),
      ocrRequiredReason: "font_metrics_nonfinite" as const,
    }));
    const deps = {
      store: h.store,
      read: async () => bytes,
      layout: async () => ({ pages: flagged }),
      put: async () => {},
      ocr: h.ocr,
      ocrPageCostCents: 1,
    };
    await runQuestionImport("job", deps);
    expect(h.ocr.readPage).toHaveBeenCalledTimes(37);
    expect(h.cost).toBe(37);
    expect(h.cache.size).toBe(37);
    expect(
      [...h.cache.values()].every(
        (p) => p[0]?.ocrRequiredReason === "font_metrics_nonfinite",
      ),
    ).toBe(true);
    await runQuestionImport("job", deps);
    expect(h.ocr.readPage).toHaveBeenCalledTimes(37);
    expect(h.cost).toBe(37);
  });
  it.each(["disabled", "budget", "cancel"])(
    "font-metric fallback respects %s before OCR execution",
    async (state) => {
      const h = harness();
      if (state === "disabled") h.job.ocrEnabled = false;
      if (state === "budget") h.job.budgetCents = 0;
      if (state === "cancel") h.cancel();
      const result = await runQuestionImport("job", {
        store: h.store,
        read: async () => bytes,
        layout: async () => ({
          pages: [
            { ...page(1, true), ocrRequiredReason: "font_metrics_nonfinite" },
          ],
        }),
        put: async () => {},
        ocr: h.ocr,
        ocrPageCostCents: 5,
      });
      expect(result.errorCode).toBe(
        state === "disabled"
          ? "ocr_required"
          : state === "budget"
            ? "budget_paused"
            : "cancelled",
      );
      expect(h.ocr.readPage).not.toHaveBeenCalled();
      expect(h.cost).toBe(0);
    },
  );

  it.each(["f33-layout-v1", "f33-layout-v2", "f33-layout-v3", "f33-layout-v4", "f33-layout-v5", "f33-layout-v6"])(
    "fails legacy queued %s before download/layout/OCR and keeps the stored version unchanged",
    async (version) => {
      const h = harness();
      h.job.parserVersion = version;
      const read = vi.fn(async () => bytes),
        layout = vi.fn(async () => ({ pages: [page(1)] })),
        put = vi.fn(async () => {});
      const result = await runQuestionImport("job", {
        store: h.store,
        read,
        layout,
        put,
        ocr: h.ocr,
      });
      expect(result.errorCode).toBe(
        "parser_version_unsupported_create_new_import",
      );
      expect(h.store.failed).toHaveBeenCalledWith(
        "job",
        "parser_version_unsupported_create_new_import",
      );
      expect(read).not.toHaveBeenCalled();
      expect(layout).not.toHaveBeenCalled();
      expect(h.ocr.readPage).not.toHaveBeenCalled();
      expect(h.job.parserVersion).toBe(version);
      expect(h.cost).toBe(0);
    },
  );
  it("refuses old OCR versions before any IO/reservation without relabeling them", async () => {
    const h = harness();
    h.job.ocrVersion = "tesseract-por-v1";
    const read = vi.fn(async () => bytes),
      layout = vi.fn(async () => ({ pages: [page(1)] }));
    const result = await runQuestionImport("job", {
      store: h.store,
      read,
      layout,
      put: async () => {},
      ocr: h.ocr,
    });
    expect(result.errorCode).toBe("ocr_version_unsupported_create_new_import");
    expect(read).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(h.ocr.readPage).not.toHaveBeenCalled();
    expect(h.cost).toBe(0);
    expect(h.job.ocrVersion).toBe("tesseract-por-v1");
  });
  it("rejects a mismatched installed model before OCR or budget reservation", async () => {
    const h = harness(),
      read = vi.fn(async () => bytes),
      verifyModel = vi.fn(async () => {
        throw new Error("ocr_model_mismatch");
      });
    const result = await runQuestionImport("job", {
      store: h.store,
      read,
      layout: async () => ({ pages: [page(1, true)] }),
      put: async () => {},
      ocr: { ...h.ocr, verifyModel },
    });
    expect(result.errorCode).toBe("ocr_model_mismatch");
    expect(read).toHaveBeenCalledOnce();
    expect(h.ocr.readPage).not.toHaveBeenCalled();
    expect(h.cost).toBe(0);
  });
  it("persists private omission geometry in durable chunks while retaining original text", async () => {
    const h = harness(),
      p = page(1);
    p.items.unshift({
      text: "PROVA ABC1",
      x: 10,
      y: 15,
      width: 80,
      height: 10,
    });
    await runQuestionImport("job", {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout: async () => ({ pages: [p] }),
    });
    const cached = h.cache.get("doc1")![0]!;
    expect(cached.items[0]!.text).toBe("PROVA ABC1");
    expect(cached.parserMarginOmissions).toEqual([
      {
        bbox: { x: 10, y: 15, width: 80, height: 10 },
        method: "text",
        reason: "known_margin",
      },
    ]);
    expect(cached.parserWarningCodes).toEqual(["margin_omitted:known_margin"]);
    expect(JSON.stringify(cached.parserMarginOmissions)).not.toContain("PROVA");
  });
  it("persists pages and produces staging candidates without publishing", async () => {
    const h = harness();
    const r = await runQuestionImport("job", {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout: async () => ({ pages: [page(1)] }),
    });
    expect(r.status).toBe("review");
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ status: "staging" });
    expect(h.store.completed).toHaveBeenCalledOnce();
  });
  it("resumes after OCR page crash with one reservation per page", async () => {
    const h = harness();
    h.fail(3);
    const deps = {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout: async () => ({
        pages: [page(1, true), page(2, true), page(3, true)],
      }),
      ocr: h.ocr,
      ocrPageCostCents: 10,
    };
    expect((await runQuestionImport("job", deps)).errorCode).toBe("crash");
    expect(h.cost).toBe(30);
    h.fail(0);
    expect((await runQuestionImport("job", deps)).status).toBe("review");
    expect(h.cost).toBe(30);
    expect(h.ocr.readPage).toHaveBeenCalledTimes(4);
    expect(h.cache.size).toBe(3);
  });
  it("caches answer key OCR too on retry", async () => {
    const h = harness();
    h.job.answerKeyDocumentId = "key";
    h.job.answerKeyObjectKey = "key";
    h.job.answerKeySha256 = sha256(bytes);
    const key = {
      ...page(1),
      items: [
        {
          text: "PROVA AD1 1 A texto auxiliar longo",
          x: 10,
          y: 10,
          width: 300,
          height: 12,
        },
      ],
    };
    const ocr = { readPage: vi.fn(async () => key) };
    let n = 0;
    const layout = async () => ({
      pages: ++n % 2 === 1 ? [page(1)] : [page(1, true)],
    });
    const deps = {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout,
      ocr,
      ocrPageCostCents: 10,
    };
    await runQuestionImport("job", deps);
    await runQuestionImport("job", deps);
    expect(ocr.readPage).toHaveBeenCalledOnce();
    expect(h.cost).toBe(10);
    expect(h.cache.has("key1")).toBe(true);
  });
  it("stops before OCR when budget is exhausted", async () => {
    const h = harness();
    h.job.budgetCents = 0;
    const r = await runQuestionImport("job", {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout: async () => ({ pages: [page(1, true)] }),
      ocr: h.ocr,
      ocrPageCostCents: 10,
    });
    expect(r.errorCode).toBe("budget_paused");
    expect(h.ocr.readPage).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });
  it("cancellation prevents all extraction and candidate writes", async () => {
    const h = harness();
    h.cancel();
    const read = vi.fn(async () => bytes);
    expect(
      (
        await runQuestionImport("job", {
          store: h.store,
          read,
          put: async () => {},
        })
      ).status,
    ).toBe("cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });
  it("rejects tampered storage bytes and mandatory OCR unavailable", async () => {
    const h = harness();
    const deps = {
      store: h.store,
      read: async () => new Uint8Array(),
      put: async () => {},
    };
    expect((await runQuestionImport("job", deps)).errorCode).toBe(
      "document_hash_mismatch",
    );
    h.job.ocrEnabled = false;
    expect(
      (
        await runQuestionImport("job", {
          ...deps,
          read: async () => bytes,
          layout: async () => ({ pages: [page(1, true)] }),
        })
      ).errorCode,
    ).toBe("ocr_required");
  });
  it("writes private crops and reuses existing stored crops after retries", async () => {
    const h = harness(),
      p = page(1);
    p.items[1]!.text = "Veja figura sintética para conferir a resposta";
    p.images = [{ x: 10, y: 70, width: 150, height: 10 }];
    const crop = vi.fn(async () => new Uint8Array([1, 2])),
      put = vi.fn(async () => {});
    const deps = {
      store: h.store,
      read: async () => bytes,
      put,
      layout: async () => ({ pages: [p] }),
      crop,
    };
    expect((await runQuestionImport("job", deps)).status).toBe("review");
    expect(crop).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    await runQuestionImport("job", { ...deps, exists: async () => true });
    expect(crop).toHaveBeenCalledOnce();
    expect(h.store.state).toHaveBeenCalledWith("job", "segmenting");
  });
  it("does not run unclaimed jobs and detects empty question documents and excessive pages", async () => {
    const h = harness();
    h.store.claim = async () => false;
    expect(
      (
        await runQuestionImport("job", {
          store: h.store,
          read: async () => bytes,
          put: async () => {},
        })
      ).status,
    ).toBe("not_claimed");
    h.store.claim = async () => true;
    const deps = {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
    };
    expect(
      (
        await runQuestionImport("job", {
          ...deps,
          layout: async () => ({
            pages: Array.from({ length: 501 }, (_, i) => page(i + 1)),
          }),
        })
      ).errorCode,
    ).toBe("page_limit");
    expect(
      (
        await runQuestionImport("job", {
          ...deps,
          layout: async () => ({
            pages: [
              {
                ...page(1),
                items: [
                  {
                    text: "Instruções longas auxiliares sem questões suficientes para extração",
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 10,
                  },
                ],
              },
            ],
          }),
        })
      ).errorCode,
    ).toBe("no_questions_detected");
  });

  it("explicitly excluded pages avoid OCR while preserving real question extraction", async () => {
    const h = harness();
    h.job.excludedPages = [2];
    expect(
      (
        await runQuestionImport("job", {
          store: h.store,
          read: async () => bytes,
          put: async () => {},
          layout: async () => ({ pages: [page(1), page(2, true)] }),
          ocr: h.ocr,
        })
      ).status,
    ).toBe("review");
    expect(h.ocr.readPage).not.toHaveBeenCalled();
    expect(h.cache.get("doc2")![0]!.reviewedNonQuestion).toBe(true);
  });
  it("rejects altered answer keys and retains typed and unknown errors without staging", async () => {
    const h = harness();
    h.job.answerKeyDocumentId = "key";
    h.job.answerKeyObjectKey = "key";
    h.job.answerKeySha256 = "different";
    const deps = {
      store: h.store,
      read: async () => bytes,
      put: async () => {},
      layout: async () => ({ pages: [page(1)] }),
    };
    expect((await runQuestionImport("job", deps)).errorCode).toBe(
      "answer_key_hash_mismatch",
    );
    expect(
      (
        await runQuestionImport("job", {
          ...deps,
          read: async () => {
            throw { code: "storage_unavailable" };
          },
        })
      ).errorCode,
    ).toBe("storage_unavailable");
    expect(
      (
        await runQuestionImport("job", {
          ...deps,
          read: async () => {
            throw "untyped";
          },
        })
      ).errorCode,
    ).toBe("import_failed");
    h.store.load = async () => null;
    expect((await runQuestionImport("job", deps)).status).toBe("not_claimed");
  });
  it("never stores document text from unexpected database/subprocess errors in telemetry codes", async () => {
    const h = harness();
    const secret = "patient_secret_explanation Dose 5 mg";
    const r = await runQuestionImport("job", {
      store: h.store,
      read: async () => {
        throw Error("Failed query parameters: " + secret);
      },
      put: async () => {},
    });
    expect(r.errorCode).toBe("import_failed");
    expect(h.store.failed).toHaveBeenCalledWith("job", "import_failed");
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
