import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  outputs: [] as (string | Error)[],
  calls: [] as unknown[][],
  removed: vi.fn(),
  read: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
}));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    mocks.calls.push(args);
    const callback = args.at(-1) as (
      error: Error | null,
      data?: { stdout: string; stderr: string },
    ) => void;
    const out = mocks.outputs.shift() ?? "";
    if (out instanceof Error) callback(out);
    else callback(null, { stdout: out, stderr: "" });
  },
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/tmp/remoa-parser-test",
  writeFile: async () => undefined,
  rm: mocks.removed,
  readFile: mocks.read,
}));
import { createTesseractOcr, renderQuestionCrop } from "./ocr";
const modelSha = createHash("sha256")
  .update(new Uint8Array([137, 80, 78, 71]))
  .digest("hex");
const mockOcr = (options: Parameters<typeof createTesseractOcr>[0] = {}) =>
  createTesseractOcr({ ...options, expectedModelSha256: modelSha });
const bytes = new Uint8Array([1]),
  page = { page: 1, width: 600, height: 800, items: [] };
beforeEach(() => {
  mocks.outputs = [];
  mocks.calls = [];
  mocks.removed.mockClear();
  mocks.read.mockClear();
});
describe("bounded OCR subprocess adapter", () => {
  it("reconstructs each TSV line by block/paragraph/line and x, preserving short words, numbers and separate columns", async () => {
    mocks.outputs = [
      "",
      "header\n5\t1\t1\t1\t1\t2\t50\t10\t5\t5\t90\to\n5\t1\t1\t1\t1\t1\t0\t8\t45\t10\t90\tsolicita\n5\t1\t1\t1\t1\t3\t65\t8\t35\t10\t90\t2 kg.\n5\t1\t2\t1\t1\t1\t330\t8\t80\t10\t90\tOutra coluna.\n",
    ];
    const result = await mockOcr().readPage(bytes, page);
    expect(result.items.map((i) => i.text)).toEqual([
      "solicita o 2 kg.",
      "Outra coluna.",
    ]);
    expect(result.items[0]).toMatchObject({
      x: 0,
      y: 3.2,
      width: 40,
      height: 4,
    });
    expect(result.items[1]!.x).toBe(132);
  });
  it("refuses a different installed model before any subprocess and memoizes the model check", async () => {
    const adapter = createTesseractOcr();
    await expect(adapter.verifyModel!()).rejects.toMatchObject({
      code: "ocr_model_mismatch",
    });
    await expect(adapter.readPage(bytes, page)).rejects.toMatchObject({
      code: "ocr_model_mismatch",
    });
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.calls).toHaveLength(0);
  });
  it("forbids non-pinned model overrides outside explicit engineering environments", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() =>
        createTesseractOcr({ expectedModelSha256: modelSha }),
      ).toThrow("restricted");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("passes the verified prefix to Tesseract even when the environment had none", async () => {
    vi.stubEnv("TESSDATA_PREFIX", undefined);
    try {
      mocks.outputs = [
        "",
        "header\n5\t1\t1\t1\t1\t1\t10\t10\t100\t10\t90\tReadable sentence.\n",
      ];
      await mockOcr().readPage(bytes, page);
      expect(mocks.read).toHaveBeenCalledWith(
        "/opt/remoa-question-tessdata/por.traineddata",
      );
      expect(mocks.calls[1]?.[2]).toMatchObject({
        env: { TESSDATA_PREFIX: "/opt/remoa-question-tessdata" },
      });
      expect(process.env.TESSDATA_PREFIX).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("validates worker configuration", () => {
    expect(() => createTesseractOcr({ language: "$(evil)" })).toThrow(
      "Invalid",
    );
    expect(() => createTesseractOcr({ dpi: 301 })).toThrow("Invalid");
    expect(() => createTesseractOcr({ timeoutMs: 1 })).toThrow("Invalid");
  });
  it("rejects pathological page geometry before starting a worker", async () => {
    await expect(
      mockOcr().readPage(bytes, { ...page, width: 100000 }),
    ).rejects.toMatchObject({ code: "ocr_failed" });
  });
  it("renders one page and consumes TSV geometry with text only", async () => {
    mocks.outputs = [
      "",
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t25\t50\t100\t30\t90\tQuestão\n5\t1\t1\t1\t1\t2\t125\t50\t20\t30\t90\t1\n4\t1\t1\t1\t1\t1\t0\t0\t0\t0\t90\tIgnored\n5\t1\t1\t1\t1\t1\tbad\t1\t1\t1\t90\tBad\nshort\n",
    ];
    const r = await mockOcr({ dpi: 180 }).readPage(bytes, page);
    expect(r.method).toBe("ocr");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      text: "Questão 1",
      x: 10,
      y: 20,
      width: 48,
      height: 12,
    });
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.calls[0]?.[0]).toBe("pdftoppm");
    expect(mocks.calls[1]?.[0]).toBe("tesseract");
    expect(mocks.removed).toHaveBeenCalledOnce();
  });
  it("fails explicitly for unavailable executable, timeout, language failure or empty OCR", async () => {
    for (const [error, code] of [
      [
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        "ocr_unavailable",
      ],
      [Object.assign(new Error("timeout"), { killed: true }), "ocr_timeout"],
      [new Error("bad language"), "ocr_failed"],
    ] as const) {
      mocks.outputs = [error];
      await expect(mockOcr().readPage(bytes, page)).rejects.toMatchObject({
        code,
      });
    }
    mocks.outputs = ["", "header\n"];
    await expect(mockOcr().readPage(bytes, page)).rejects.toMatchObject({
      code: "ocr_failed",
    });
    expect(mocks.removed).toHaveBeenCalledTimes(4);
  });
});
describe("review crops", () => {
  it("rejects invalid boxes and renders bounded geometry without shell", async () => {
    await expect(
      renderQuestionCrop(bytes, page, { x: -1, y: 0, width: 1, height: 1 }),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
    await expect(
      renderQuestionCrop(
        bytes,
        { ...page, page: 1.5 },
        { x: 0, y: 0, width: 1, height: 1 },
      ),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
    await expect(
      renderQuestionCrop(bytes, page, { x: 0, y: 0, width: 0, height: 1 }),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
    await expect(
      renderQuestionCrop(bytes, page, {
        x: 0,
        y: 0,
        width: 10000,
        height: 10000,
      }),
    ).rejects.toMatchObject({ code: "invalid_pdf" });
    const png = await renderQuestionCrop(bytes, page, {
      x: 1,
      y: 2,
      width: 50,
      height: 60,
    });
    expect(png[0]).toBe(137);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.removed).toHaveBeenCalledOnce();
  });
  it("maps subprocess failures and always deletes files", async () => {
    for (const [error, code] of [
      [
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        "ocr_unavailable",
      ],
      [Object.assign(new Error("timeout"), { killed: true }), "ocr_timeout"],
      [new Error("bad"), "ocr_failed"],
    ] as const) {
      mocks.outputs = [error];
      await expect(
        renderQuestionCrop(bytes, page, { x: 0, y: 0, width: 1, height: 1 }),
      ).rejects.toMatchObject({ code });
    }
    expect(mocks.removed).toHaveBeenCalledTimes(3);
  });
});
