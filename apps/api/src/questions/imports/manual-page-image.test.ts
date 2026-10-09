import sharp from "sharp";
import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn(),
  layout: vi.fn(),
  render: vi.fn(),
}));
vi.mock("../../storage/storage", () => ({
  getBytes: mocks.get,
  headObject: mocks.head,
  putBytes: mocks.put,
}));
vi.mock("@remoa/ai", () => ({ readPdfPageGeometry: mocks.layout }));
vi.mock("../pdf", () => ({ renderQuestionCrop: mocks.render }));
import { preparePageImage, pageImageIo } from "./manual-page-image";
import { sha256 } from "./domain";
const pdf = Buffer.from("%PDF- synthetic page");
const document = {
  id: "synthetic-doc",
  objectKey: "private/exam.pdf",
  sha256: sha256(pdf),
  bytes: pdf.length,
  pages: 1,
};
let png: Buffer;
beforeEach(async () => {
  vi.clearAllMocks();
  png = await sharp({
    create: { width: 100, height: 200, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  mocks.head.mockImplementation(async (key: string) =>
    key === document.objectKey
      ? { size: pdf.length, mime: "application/pdf" }
      : null,
  );
  mocks.get.mockResolvedValue(pdf);
  mocks.layout.mockResolvedValue({
    page: 1,
    width: 72,
    height: 144,
    totalPages: 1,
  });
  mocks.render.mockResolvedValue(png);
  mocks.put.mockImplementation(async () => {
    mocks.head.mockResolvedValue({ size: png.length, mime: "image/png" });
    mocks.get.mockResolvedValue(png);
  });
});
describe("CCR118 deterministic full-page evidence IO", () => {
  it("renders the complete rotated viewport, persists and verifies PNG bytes/hash", async () => {
    const image = await preparePageImage("import", "candidate", document, 1);
    expect(image).toMatchObject({
      created: true,
      width: 100,
      height: 200,
      sha256: sha256(png),
      bytes: png.length,
      page: 1,
    });
    expect(Buffer.from(mocks.render.mock.calls[0]![0])).toEqual(pdf);
    expect(mocks.render.mock.calls[0]!.slice(1)).toEqual([
      expect.objectContaining({ width: 72, height: 144 }),
      { x: 0, y: 0, width: 72, height: 144 },
      100,
    ]);
    expect(mocks.put.mock.calls[0]![0]).toContain(
      "manual-candidate-1-" + document.sha256 + "-full-page-v1.png",
    );
  });
  it("reuses HEAD-valid cached objects without PDF loading, rendering or PUT and rejects modified cached hashes", async () => {
    mocks.head.mockResolvedValue({ size: png.length, mime: "image/png" });
    mocks.get.mockResolvedValue(png);
    const result = await preparePageImage("import", "candidate", document, 1, {
      sha256: sha256(png),
      bytes: png.length,
    });
    expect(result.created).toBe(false);
    expect(mocks.layout).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    await expect(
      preparePageImage("import", "candidate", document, 1, {
        sha256: "a".repeat(64),
        bytes: png.length,
      }),
    ).rejects.toThrow("page_image_cached_hash_mismatch");
  });
  it("rejects page/bytes/pixel bounds, invalid document hashes and rotated dimension mismatches", async () => {
    await expect(preparePageImage("i", "c", document, 2)).rejects.toThrow(
      "page_image_document_limit",
    );
    await expect(
      preparePageImage("i", "c", { ...document, bytes: 101 * 1024 * 1024 }, 1),
    ).rejects.toThrow("page_image_document_limit");
    mocks.get.mockResolvedValue(Buffer.from("%PDF- replaced document"));
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_document_hash_mismatch",
    );
    mocks.get.mockResolvedValue(pdf);
    mocks.layout.mockResolvedValue({
      page: 1,
      width: 10000,
      height: 10000,
      totalPages: 1,
    });
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_geometry_limit",
    );
    mocks.layout.mockResolvedValue({
      page: 1,
      width: 144,
      height: 72,
      totalPages: 1,
    });
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_geometry_mismatch",
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("reports a newly written orphan key if storage verification fails; cleanup remains claim-controlled", async () => {
    mocks.put.mockImplementation(async () =>
      mocks.head.mockResolvedValue(null),
    );
    await expect(preparePageImage("i", "c", document, 1)).rejects.toMatchObject(
      {
        message: "page_image_storage_verification_failed",
        createdObjectKey: expect.stringContaining(
          "questions/imports/i/crops/manual-c-",
        ),
      },
    );
  });
  it("rejects unavailable or altered cached objects and refuses a missing original document", async () => {
    mocks.head.mockResolvedValue({ size: png.length, mime: "application/pdf" });
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_cached_invalid",
    );
    mocks.head.mockResolvedValue({ size: png.length + 1, mime: "image/png" });
    mocks.get.mockResolvedValue(png);
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_cached_size_mismatch",
    );
    mocks.head.mockResolvedValue(null);
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_document_unavailable",
    );
  });
  it("checks post-write hash, renderer failures and invalid PNG output explicitly", async () => {
    mocks.put.mockImplementation(async () => {
      mocks.head.mockResolvedValue({ size: png.length, mime: "image/png" });
      mocks.get.mockResolvedValue(Buffer.alloc(png.length));
    });
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_storage_verification_failed",
    );
    mocks.head.mockImplementation(async (k: string) =>
      k === document.objectKey
        ? { size: pdf.length, mime: "application/pdf" }
        : null,
    );
    mocks.get.mockResolvedValue(pdf);
    mocks.render.mockRejectedValue({ code: "ocr_timeout" });
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_render_timeout",
    );
    mocks.render.mockRejectedValue(Error("missing binary"));
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_render_unavailable",
    );
    mocks.render.mockResolvedValue(new Uint8Array());
    await expect(preparePageImage("i", "c", document, 1)).rejects.toThrow(
      "page_image_byte_limit",
    );
  });
  it("rejects unreadable PDF geometry explicitly", async () => {
    mocks.layout.mockRejectedValue(Error("invalid document"));
    await expect(preparePageImage("i","c",document,1)).rejects.toThrow("page_image_invalid_pdf");
  });
  it("enforces actual IO cancellation with an AbortSignal", async () => {
    await expect(
      pageImageIo(
        (signal) =>
          new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(Error("aborted"))),
          ),
        5,
      ),
    ).rejects.toThrow("page_image_storage_timeout");
  });
});
