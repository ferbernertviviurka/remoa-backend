/** CCR118: bounded private page evidence; never OCR, AI, or automatic public illustration. */
import sharp from "sharp";
import { readPdfPageGeometry } from "@remoa/ai";
import { renderQuestionCrop } from "../pdf";
import { getBytes, headObject, putBytes } from "../../storage/storage";
import { sha256 } from "./domain";
export const MANUAL_PAGE_IMAGE_VERSION = "full-page-v1";
const PDF_LIMIT = 100 * 1024 * 1024,
  PNG_LIMIT = 32 * 1024 * 1024,
  PIXEL_LIMIT = 20_000_000;
export interface PageImageDocument {
  id: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  pages: number;
}
export interface PreparedPageImage {
  objectKey: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  created: boolean;
  documentId: string;
  documentHash: string;
  page: number;
}
export const pageImageIo = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms = 10000,
): Promise<T> => {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), ms);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw Error("page_image_storage_timeout");
    if (error instanceof Error && error.message === "storage_byte_limit")
      throw Error("page_image_byte_limit");
    throw Error("page_image_storage_unavailable");
  } finally {
    clearTimeout(timer);
  }
};
async function pngMetadata(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > PNG_LIMIT)
    throw Error("page_image_byte_limit");
  const meta = await sharp(bytes, { limitInputPixels: PIXEL_LIMIT }).metadata();
  if (
    meta.format !== "png" ||
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > PIXEL_LIMIT
  )
    throw Error("page_image_invalid_png");
  return { width: meta.width, height: meta.height };
}
export async function preparePageImage(
  importId: string,
  candidateId: string,
  document: PageImageDocument,
  page: number,
  expected?: { sha256: string; bytes: number },
): Promise<PreparedPageImage> {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > document.pages ||
    document.pages < 1 ||
    document.pages > 500 ||
    document.bytes < 5 ||
    document.bytes > PDF_LIMIT
  )
    throw Error("page_image_document_limit");
  const objectKey = `questions/imports/${importId}/crops/manual-${candidateId}-${page}-${document.sha256}-${MANUAL_PAGE_IMAGE_VERSION}.png`;
  const existing = await pageImageIo((signal) => headObject(objectKey, signal));
  if (existing) {
    if (
      existing.mime !== "image/png" ||
      existing.size < 1 ||
      existing.size > PNG_LIMIT
    )
      throw Error("page_image_cached_invalid");
    const bytes = await pageImageIo((signal) =>
      getBytes(objectKey, { signal, maxBytes: PNG_LIMIT }),
    );
    if (bytes.length !== existing.size)
      throw Error("page_image_cached_size_mismatch");
    if (
      expected &&
      (expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes))
    )
      throw Error("page_image_cached_hash_mismatch");
    const dimensions = await pngMetadata(bytes);
    return {
      objectKey,
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...dimensions,
      created: false,
      documentId: document.id,
      documentHash: document.sha256,
      page,
    };
  }
  const head = await pageImageIo((signal) =>
    headObject(document.objectKey, signal),
  );
  if (
    !head ||
    head.size !== document.bytes ||
    head.size > PDF_LIMIT ||
    head.mime !== "application/pdf"
  )
    throw Error("page_image_document_unavailable");
  const bytes = new Uint8Array(
    await pageImageIo((signal) =>
      getBytes(document.objectKey, { signal, maxBytes: PDF_LIMIT }),
    ),
  );
  if (
    bytes.length !== document.bytes ||
    sha256(bytes) !== document.sha256 ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
  )
    throw Error("page_image_document_hash_mismatch");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  let geometry: Awaited<ReturnType<typeof readPdfPageGeometry>>;
  try {
    geometry = await readPdfPageGeometry(bytes, page, {
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) throw Error("page_image_layout_timeout");
    throw Error("page_image_invalid_pdf");
  } finally {
    clearTimeout(timer);
  }
  if (
    geometry.totalPages !== document.pages ||
    geometry.width <= 0 ||
    geometry.height <= 0 ||
    geometry.width * geometry.height * (100 / 72) ** 2 > PIXEL_LIMIT
  )
    throw Error("page_image_geometry_limit");
  let png: Uint8Array;
  try {
    png = await renderQuestionCrop(
      bytes,
      { ...geometry, items: [] },
      { x: 0, y: 0, width: geometry.width, height: geometry.height },
      100,
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ocr_timeout"
    )
      throw Error("page_image_render_timeout");
    throw Error("page_image_render_unavailable");
  }
  const dimensions = await pngMetadata(png);
  // Full page dimensions must match the rotated PDF viewport, allowing Poppler's rounding.
  if (
    Math.abs(dimensions.width - (geometry.width * 100) / 72) > 2 ||
    Math.abs(dimensions.height - (geometry.height * 100) / 72) > 2
  )
    throw Error("page_image_geometry_mismatch");
  try {
    await pageImageIo((signal) =>
      putBytes(objectKey, Buffer.from(png), "image/png", signal),
    );
    const storedHead = await pageImageIo((signal) =>
      headObject(objectKey, signal),
    );
    if (
      !storedHead ||
      storedHead.mime !== "image/png" ||
      storedHead.size !== png.length
    )
      throw Error("page_image_storage_verification_failed");
    const stored = await pageImageIo((signal) =>
      getBytes(objectKey, { signal, maxBytes: PNG_LIMIT }),
    );
    if (stored.length !== png.length || sha256(stored) !== sha256(png))
      throw Error("page_image_storage_verification_failed");
    return {
      objectKey,
      sha256: sha256(png),
      bytes: png.length,
      ...dimensions,
      created: true,
      documentId: document.id,
      documentHash: document.sha256,
      page,
    };
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : Error("page_image_storage_failure"),
      { createdObjectKey: objectKey },
    );
  }
}
