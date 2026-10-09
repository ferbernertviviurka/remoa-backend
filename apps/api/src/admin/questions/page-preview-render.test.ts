/** Explicit local pilot: real PDF + unpdf + Poppler, private memory storage, no DB/OCR/provider. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readPdfPageGeometry } from '@remoa/ai';
import { ok } from '@remoa/contracts';
const f = vi.hoisted(() => ({ objects: new Map<string, { bytes: Buffer; mime: string }>(), puts: 0 }));
vi.mock('../../storage/storage', () => ({
  headObject: async (key: string) => { const object = f.objects.get(key); return object ? { size: object.bytes.length, mime: object.mime } : null; },
  getBytes: async (key: string) => { const object = f.objects.get(key); if (!object) throw Error('missing fixture'); return object.bytes; },
  putBytes: async (key: string, bytes: Buffer, mime: string) => { f.puts++; f.objects.set(key, { bytes, mime }); },
  presignGet: async () => 'http://localhost:9000/private/original-page.png',
}));
import { originalPagePreview, type PagePreviewMetadata } from './page-preview';
import { sha256 } from '../../questions/imports/domain';
describe.skipIf(process.env.PAGE_PREVIEW_PILOT !== '1')('real original authorial page preview', () => {
  it('renders a real full-page PNG and reuses verified bytes without another render/PUT', async () => {
    const pdf = await readFile(fileURLToPath(new URL('../../../../../../docs/content/questions/corpus/output/pdf/C01-exam.pdf', import.meta.url)));
    const geometry = await readPdfPageGeometry(new Uint8Array(pdf), 1);
    const id = '00000000-0000-4000-8000-000000000001', documentId = '00000000-0000-4000-8000-000000000002';
    const objectKey = `questions/documents/pilot/${documentId}.pdf`;
    f.objects.set(objectKey, { bytes: pdf, mime: 'application/pdf' });
    const meta: PagePreviewMetadata = { document: { id: documentId, objectKey, sha256: sha256(pdf), bytes: pdf.length, pages: geometry.totalPages, sourceId: 'source', kind: 'exam' }, job: { id, documentId, sourceId: 'source', revision: 0, status: 'review', excludedPages: [] }, source: { id: 'source', rightsStatus: 'pending', rightsExpiresAt: null } };
    const first = await originalPagePreview(meta, 1, async () => ok(meta));
    expect(first.ok).toBe(true);
    if (!first.ok) throw Error('pilot failed');
    expect(Math.abs(first.data.width - geometry.width * 100 / 72)).toBeLessThanOrEqual(2);
    expect(Math.abs(first.data.height - geometry.height * 100 / 72)).toBeLessThanOrEqual(2);
    const png = [...f.objects.values()].find(object => object.mime === 'image/png')!.bytes;
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(sha256(png)).toBe(first.data.imageSha256);
    await writeFile('/private/tmp/remoa-f33-page-preview-pilot.png', png, { mode: 0o600 });
    const again = await originalPagePreview(meta, 1, async () => ok(meta));
    expect(again).toEqual(first); expect(f.puts).toBe(1);
  }, 15000);
});
