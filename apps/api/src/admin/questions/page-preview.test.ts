import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@remoa/contracts';
const f = vi.hoisted(() => ({ prepare: vi.fn(), sign: vi.fn() }));
vi.mock('../../questions/imports/manual-page-image', () => ({ preparePageImage: f.prepare }));
vi.mock('../../storage/storage', () => ({ presignGet: f.sign }));
import { originalPagePreview, validatePagePreview, withOriginalPagePreview, type PagePreviewMetadata } from './page-preview';
const meta = (): PagePreviewMetadata => ({
  document: { id: '00000000-0000-4000-8000-000000000001', objectKey: 'questions/documents/admin/doc.pdf', sha256: 'a'.repeat(64), bytes: 123, pages: 3, kind: 'exam', sourceId: 'source' },
  job: { id: '00000000-0000-4000-8000-000000000002', sourceId: 'source', documentId: '00000000-0000-4000-8000-000000000001', status: 'review', revision: 2, excludedPages: [3] },
  source: { id: 'source', rightsStatus: 'pending', rightsExpiresAt: null },
});
beforeEach(() => {
  vi.clearAllMocks();
  f.prepare.mockResolvedValue({ width: 1200, height: 800, objectKey: 'questions/imports/import/crops/cache.png', sha256: 'b'.repeat(64) });
  f.sign.mockResolvedValue('https://storage.example/page.png');
});
describe('private original exam page preview', () => {
  it('returns original rotated PNG dimensions and full normalized provenance without raw storage keys', async () => {
    const m = meta();
    const result = await originalPagePreview(m, 1, async () => ok(m));
    expect(result).toMatchObject({ ok: true, data: { width: 1200, height: 800, dpi: 100, expiresInSec: 300, provenance: { documentId: '00000000-0000-4000-8000-000000000001', page: 1, bbox: [0, 0, 1, 1] } } });
    expect(f.prepare).toHaveBeenCalledWith(m.job.id, `page-preview-dpi100-render-full-page-v1-${m.document.id}`, m.document, 1);
    expect(f.sign).toHaveBeenCalledWith('questions/imports/import/crops/cache.png', 300);
    expect(JSON.stringify(result)).not.toContain('objectKey');
  });
  it.each([0, 1.5, 3, 4, 501])('rejects out-of-bounds/excluded page %s before any storage IO', async page => {
    expect((await originalPagePreview(meta(), page, async () => ok(meta()))).ok).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('never signs when rights are withdrawn, expire, or the actor loses permission during rendering', async () => {
    for (const change of [{ rightsStatus: 'revoked' }, { rightsExpiresAt: new Date(0) }]) {
      const m = meta(), current = { ...m, source: { ...m.source, ...change } };
      expect(await originalPagePreview(m, 1, async () => ok(current))).toMatchObject({ ok: false });
    }
    expect(await originalPagePreview(meta(), 1, async () => err('not_found', 'route not found'))).toMatchObject({ ok: false });
    expect(f.sign).not.toHaveBeenCalled();
  });
  it('rejects source/document mismatch, answer-key docs and arbitrary private object namespaces', () => {
    for (const document of [{ ...meta().document, kind: 'answer_key' }, { ...meta().document, sourceId: 'foreign' }, { ...meta().document, objectKey: 'unrelated/private.pdf' }])
      expect(validatePagePreview({ ...meta(), document }, 1).ok).toBe(false);
  });
  it('never signs a stale revision or mutated source document', async () => {
    const m = meta();
    expect(await originalPagePreview(m, 1, async () => ok({ ...m, job: { ...m.job, revision: 3 } }))).toMatchObject({ ok: false, error: { message: 'page_preview_metadata_changed' } });
    expect(await originalPagePreview(m, 1, async () => ok({ ...m, document: { ...m.document, sha256: 'c'.repeat(64) } }))).toMatchObject({ ok: false });
    expect(f.sign).not.toHaveBeenCalled();
  });
  it('releases bounded process capacity after failure and limits requests per actor', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const one = withOriginalPagePreview('capacity-one', async () => { await wait; return ok({}); });
    const two = withOriginalPagePreview('capacity-two', async () => { await wait; return ok({}); });
    expect(await withOriginalPagePreview('capacity-three', async () => ok({}))).toMatchObject({ ok: false });
    release(); await Promise.all([one, two]);
    await expect(withOriginalPagePreview('failure', async () => { throw Error('storage unavailable'); })).rejects.toThrow();
    for (let n = 0; n < 30; n++) expect((await withOriginalPagePreview('rate-actor', async () => ok({}), 1000)).ok).toBe(true);
    expect((await withOriginalPagePreview('rate-actor', async () => ok({}), 1000)).ok).toBe(false);
    expect((await withOriginalPagePreview('rate-actor', async () => ok({}), 62000)).ok).toBe(true);
  });
});
