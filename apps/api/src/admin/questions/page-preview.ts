/** Private original-page rendering for marker recovery. No OCR, candidate mutation or public asset. */
import { and, eq } from 'drizzle-orm';
import { err, ok, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../../db';
import { presignGet } from '../../storage/storage';
import { preparePageImage, type PageImageDocument, type PreparedPageImage } from '../../questions/imports/manual-page-image';
import { accountState, isFresh, send, withAdmin, type AdminEnv } from '../core';
import { ADMIN_LIMITS, adminErrors, questionDocumentPagePreviewSchema, questionDocumentPageImageSchema } from '@remoa/contracts';
import type { Context } from 'hono';

export interface PagePreviewMetadata {
  document: PageImageDocument & { kind: string; sourceId: string };
  job: { id: string; documentId: string; sourceId: string; status: string; revision: number; excludedPages: number[] };
  source: { id: string; rightsStatus: string; rightsExpiresAt: Date | null };
}
export interface PrivatePagePreview {
  importId: string; documentId: string; page: number; pages: number;
  width: number; height: number; dpi: 100;
  documentSha256: string; imageSha256: string; url: string; expiresInSec: 300;
  provenance: { documentId: string; page: number; bbox: [number, number, number, number] };
}
const previewHits = new Map<string, number[]>();
let activePreviews = 0;
/** Admission is per API instance. It bounds cached requests too, not a global distributed quota. */
export async function withOriginalPagePreview<T>(userId: string, operation: () => Promise<Result<T>>, now = Date.now()): Promise<Result<T>> {
  if (previewHits.size > 10_000) for (const [key, hits] of previewHits) if (hits.every(t => now - t >= 60_000)) previewHits.delete(key);
  const hits = (previewHits.get(userId) ?? []).filter(t => now - t < 60_000);
  if (hits.length >= 30 || activePreviews >= 2) return err('rate_limited', 'page_preview_capacity');
  previewHits.set(userId, [...hits, now]);
  activePreviews++;
  try { return await operation(); } finally { activePreviews--; }
}
export function validatePagePreview(meta: PagePreviewMetadata | null, page: number): Result<PagePreviewMetadata> {
  if (!meta) return err('not_found', 'document not found');
  if (meta.document.kind !== 'exam' || meta.job.documentId !== meta.document.id || meta.document.sourceId !== meta.source.id || meta.job.sourceId !== meta.source.id)
    return err('not_found', 'document not found');
  if (!['review', 'completed'].includes(meta.job.status)) return err('conflict', 'import_not_in_review');
  if (!['pending', 'authorized'].includes(meta.source.rightsStatus) || (meta.source.rightsExpiresAt && meta.source.rightsExpiresAt.getTime() <= Date.now()))
    return err('conflict', 'source_rights_unavailable');
  if (!Number.isInteger(page) || page < 1 || page > meta.document.pages || meta.document.pages > 500 || meta.document.pages < 1 || meta.job.excludedPages.includes(page))
    return err('validation', 'page_not_available_for_recovery');
  if (meta.document.bytes < 5 || meta.document.bytes > 100 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(meta.document.sha256) || !meta.document.objectKey.startsWith('questions/documents/'))
    return err('validation', 'page_preview_document_invalid');
  return ok(meta);
}
export async function pagePreviewMetadata(importId: string, documentId: string, page: number, tx?: Tx): Promise<Result<PagePreviewMetadata>> {
  const { db, questionImports: i, questionDocuments: d, questionSourcesCatalog: s } = await dbm();
  const [row] = await (tx ?? db).select({
    document: { id: d.id, objectKey: d.objectKey, sha256: d.sha256, bytes: d.bytes, pages: d.pages, kind: d.kind, sourceId: d.sourceId },
    job: { id: i.id, documentId: i.documentId, sourceId: i.sourceId, status: i.status, revision: i.revision, excludedPages: i.excludedPages },
    source: { id: s.id, rightsStatus: s.rightsStatus, rightsExpiresAt: s.rightsExpiresAt },
  }).from(i).innerJoin(d, eq(i.documentId, d.id)).innerJoin(s, eq(i.sourceId, s.id)).where(and(eq(i.id, importId), eq(d.id, documentId)));
  return validatePagePreview(row?.document.pages ? { ...row, document: { ...row.document, pages: row.document.pages } } : null, page);
}
export async function prepareOriginalPagePreview(meta: PagePreviewMetadata, page: number): Promise<Result<PreparedPageImage>> {
  const valid = validatePagePreview(meta, page);
  if (!valid.ok) return valid;
  const image = await preparePageImage(meta.job.id, `page-preview-dpi100-render-full-page-v1-${meta.document.id}`, meta.document, page);
  if (image.width > 20_000 || image.height > 20_000 || image.width * image.height > 20_000_000)
    return err('validation', 'page_preview_geometry_limit');
  return ok(image);
}
export async function finishOriginalPagePreview(meta: PagePreviewMetadata, page: number, image: PreparedPageImage, current: PagePreviewMetadata): Promise<Result<PrivatePagePreview>> {
  const checked = validatePagePreview(current, page);
  if (!checked.ok) return checked;
  if (meta.job.id !== current.job.id || meta.document.id !== current.document.id || meta.job.revision !== current.job.revision || meta.document.sha256 !== current.document.sha256 || meta.document.bytes !== current.document.bytes || meta.document.pages !== current.document.pages || meta.document.objectKey !== current.document.objectKey || meta.source.id !== current.source.id || JSON.stringify(meta.job.excludedPages) !== JSON.stringify(current.job.excludedPages))
    return err('conflict', 'page_preview_metadata_changed');
  const parsed = questionDocumentPageImageSchema.safeParse({
    importId: meta.job.id, documentId: meta.document.id, page, pages: meta.document.pages,
    width: image.width, height: image.height, dpi: 100,
    documentSha256: meta.document.sha256, imageSha256: image.sha256,
    url: await presignGet(image.objectKey, 300), expiresInSec: 300,
    provenance: { documentId: meta.document.id, page, bbox: [0, 0, 1, 1] },
  });
  return parsed.success ? ok(parsed.data as PrivatePagePreview) : err('validation', 'page_preview_output_invalid');
}
export async function originalPagePreview(meta: PagePreviewMetadata, page: number, recheck: () => Promise<Result<PagePreviewMetadata>>): Promise<Result<PrivatePagePreview>> {
  const prepared = await prepareOriginalPagePreview(meta, page);
  if (!prepared.ok) return prepared;
  const current = await recheck();
  return current.ok ? finishOriginalPagePreview(meta, page, prepared.data, current.data) : current;
}
function previewIoFailure(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : '';
  return /^page_image_(document_limit|document_hash_mismatch|invalid_pdf|geometry_limit|geometry_mismatch|byte_limit|invalid_png)$/.test(message)
    ? err('validation', 'page_preview_invalid_document') : err('internal', 'page_preview_unavailable');
}
async function activePreviewAdmin(c: Context<AdminEnv>): Promise<Result<Record<string, never>>> {
  const actor = await accountState(c.get('admin').id);
  if (!actor || actor.role !== 'admin' || actor.deletedAt || actor.suspendedAt || !actor.email) return err('not_found', 'route not found');
  if (!isFresh(c.get('authAt'), ADMIN_LIMITS.reauthMinutes * 60_000)) return err('forbidden', adminErrors.reauth);
  return ok({});
}
export async function documentPagePreviewResponse(c: Context<AdminEnv>) {
  const importId = c.req.param('id') ?? '', documentId = c.req.param('documentId') ?? '', rawPage = c.req.param('page') ?? '';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!uuid.test(importId) || !uuid.test(documentId) || !/^[1-9]\d{0,2}$/.test(rawPage)) return send(err('not_found', 'document not found'));
  const page = Number(rawPage);
  const actor = await activePreviewAdmin(c);
  const initial = actor.ok ? await pagePreviewMetadata(importId, documentId, page) : actor;
  let prepared: Result<PreparedPageImage> = err('internal', 'page_preview_unavailable');
  if (initial.ok) {
    try { prepared = await withOriginalPagePreview(c.get('admin').id, () => prepareOriginalPagePreview(initial.data, page)); }
    catch (error) { prepared = previewIoFailure(error); }
  }
  const result = await withAdmin<PrivatePagePreview>(c, 'question.import_view', {
    reason: 'Conferir imagem privada da página original para recuperação de marcador',
    target: { type: 'question_import', id: importId },
  }, async (tx, audit) => {
    if (!initial.ok) return initial;
    const active = await activePreviewAdmin(c);
    if (!active.ok) return active;
    const current = await pagePreviewMetadata(importId, documentId, page, tx);
    if (!current.ok) return current;
    if (!prepared.ok) return prepared;
    try {
      const preview = await finishOriginalPagePreview(initial.data, page, prepared.data, current.data);
      if (preview.ok) audit.after({ documentId, page, importRevision: current.data.job.revision, imageSha256: preview.data.imageSha256 });
      return preview;
    } catch (error) { return previewIoFailure(error); }
  });
  if (!result.ok) {
    if (result.error.code === 'internal' && result.error.message === 'page_preview_unavailable')
      return Response.json({ error: result.error }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'private, no-store' } });
    return send(result);
  }
  const dto = questionDocumentPagePreviewSchema.parse(result.data);
  return Response.json({ ok: true, data: dto }, { headers: { 'Cache-Control': 'private, no-store' } });
}
