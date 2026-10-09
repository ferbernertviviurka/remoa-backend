import { describe, expect, it } from 'vitest';
import { questionDocumentPagePreviewSchema } from './question-page-preview';
const id = '00000000-0000-4000-8000-000000000001';
const value = () => ({
  importId: id, documentId: id, page: 1, pages: 2, width: 1200, height: 800, dpi: 100,
  documentSha256: 'a'.repeat(64), imageSha256: 'b'.repeat(64), url: 'https://storage.example/page.png', expiresInSec: 300,
  provenance: { documentId: id, page: 1, bbox: [0, 0, 1, 1] },
  audit: { id: 1, createdAt: '2026-10-09T00:00:00Z', actorType: 'admin', actor: null, action: 'question.import_view', targetType: 'question_import', targetId: id, targetLabel: null, reason: 'Conferir página original', result: 'success', denial: null, before: null, after: null, ipHash: null, userAgent: null, requestId: null },
});
describe('CCR131 original page boundary', () => {
  it.each(['https://storage.example/page.png','http://localhost:9000/page.png'])('accepts a server-signed private full-page image %s and audit', url => expect(questionDocumentPagePreviewSchema.safeParse({...value(),url}).success).toBe(true));
  it.each([{ width: 20000, height: 20000 }, { width: 20001 }, { page: 3 }, { pages: 501 }, { expiresInSec: 3600 }, { dpi: 180 }, { url: 'file:///private/raw.png' }, { url: 'javascript:alert(1)' }, { documentSha256: 'A'.repeat(64) }, { objectKey: 'private/raw' }])('rejects invalid bounds or raw storage fields %j', patch => expect(questionDocumentPagePreviewSchema.safeParse({ ...value(), ...patch }).success).toBe(false));
  it('rejects mismatched provenance, invented method and partial crop', () => {
    for (const provenance of [{ ...value().provenance, page: 2 }, { ...value().provenance, documentId: '00000000-0000-4000-8000-000000000002' }, { ...value().provenance, bbox: [0, 0, 0.5, 1] }, { ...value().provenance, method: 'manual_page' }])
      expect(questionDocumentPagePreviewSchema.safeParse({ ...value(), provenance }).success).toBe(false);
  });
});
