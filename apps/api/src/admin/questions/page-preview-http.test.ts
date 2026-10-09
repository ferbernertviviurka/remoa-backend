import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { err, ok, errorHttpStatus } from '@remoa/contracts';
import type { AdminEnv } from '../core';
const f = vi.hoisted(() => ({ rows: [] as unknown[], actor: {} as Record<string, unknown>, prepare: vi.fn(), sign: vi.fn(), outcomes: [] as string[], queries: 0, tx: false, fresh: true }));
const chain = () => ({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({ where: async () => { f.queries++; return f.rows; } }) }) }) });
vi.mock('../../db', () => ({ dbm: async () => ({ db: { select: chain }, questionImports: {}, questionDocuments: {}, questionSourcesCatalog: {} }) }));
vi.mock('../../questions/imports/manual-page-image', () => ({ preparePageImage: f.prepare }));
vi.mock('../../storage/storage', () => ({ presignGet: f.sign }));
const audit = { id: 1, createdAt: new Date(), actorType: 'admin', actor: null, action: 'question.import_view', targetType: 'question_import', targetId: 'import', targetLabel: null, reason: 'Conferência autorizada', result: 'success', denial: null, before: null, after: null, ipHash: null, userAgent: null, requestId: null };
vi.mock('../core', () => ({
  accountState: async () => f.actor, isFresh: () => f.fresh,
  send: (r: { ok: boolean; error: { code: keyof typeof errorHttpStatus } }) => Response.json(r.ok ? r : { error: r.error }, { status: r.ok ? 200 : errorHttpStatus[r.error.code] }),
  withAdmin: async (_c: unknown, _action: unknown, _opts: unknown, run: (tx: unknown, capture: unknown) => Promise<{ ok: boolean; data?: object; error?: object }>) => {
    f.tx = true;
    try {
      if (!f.fresh) { f.outcomes.push('denied'); return err('forbidden', 'reauth'); }
      const result = await run({ select: chain }, { after: () => {}, before: () => {} });
      f.outcomes.push(result.ok ? 'success' : 'denied');
      return result.ok ? ok({ ...result.data, audit }) : result;
    } finally { f.tx = false; }
  },
}));
import { documentPagePreviewResponse } from './page-preview';
const id = '00000000-0000-4000-8000-000000000001', doc = '00000000-0000-4000-8000-000000000002';
function app() {
  const a = new Hono<AdminEnv>();
  a.use('*', async (c, next) => { c.set('admin', { id, name: 'Synthetic', email: 'synthetic@example.org' }); c.set('authAt', Date.now()); await next(); });
  return a.get('/imports/:id/documents/:documentId/pages/:page/preview', documentPagePreviewResponse);
}
const request = () => app().request(`/imports/${id}/documents/${doc}/pages/1/preview`);
beforeEach(() => {
  vi.clearAllMocks(); f.outcomes = []; f.queries = 0; f.tx = false; f.fresh = true;
  f.actor = { role: 'admin', deletedAt: null, suspendedAt: null, email: 'synthetic@example.org' };
  f.rows = [{ document: { id: doc, sourceId: 'source', kind: 'exam', bytes: 10, pages: 2, sha256: 'a'.repeat(64), objectKey: 'questions/documents/actor/doc.pdf' }, job: { id, documentId: doc, sourceId: 'source', status: 'review', revision: 1, excludedPages: [] }, source: { id: 'source', rightsStatus: 'pending', rightsExpiresAt: null } }];
  f.prepare.mockImplementation(async () => { expect(f.tx).toBe(false); return { objectKey: 'private/cache.png', width: 800, height: 1200, sha256: 'b'.repeat(64) }; });
  f.sign.mockImplementation(async () => { expect(f.tx).toBe(true); return 'http://localhost:9000/private/cache.png'; });
});
describe('preview request final audit outcome without DB or provider', () => {
  it('renders outside TX, signs after final guards, and audits exactly one actual success', async () => {
    const response = await request(); expect(response.status).toBe(200); expect(f.outcomes).toEqual(['success']);
    expect(f.queries).toBe(2); expect(f.sign).toHaveBeenCalledOnce(); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('rejects an early non-admin or stale reauthentication before metadata and rendering and audits one denial', async () => {
    f.actor.role = 'student'; expect((await request()).status).toBe(404); expect(f.queries).toBe(0); expect(f.prepare).not.toHaveBeenCalled(); expect(f.outcomes).toEqual(['denied']);
    f.actor.role = 'admin'; f.fresh = false; f.outcomes = []; expect((await request()).status).toBe(403); expect(f.queries).toBe(0); expect(f.outcomes).toEqual(['denied']);
  });
  it('records storage failure as one denied outcome with an explicit retryable 503', async () => {
    f.prepare.mockRejectedValueOnce(Error('page_image_storage_unavailable'));
    const response = await request(); expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('5');
    expect(f.outcomes).toEqual(['denied']); expect(f.sign).not.toHaveBeenCalled();
  });
  it.each(['role', 'source', 'revision'])('rechecks %s after rendering and records denial instead of a successful preview audit', async change => {
    f.prepare.mockImplementationOnce(async () => {
      if (change === 'role') f.actor.role = 'student';
      else { const row = f.rows[0] as { source: { rightsStatus: string }; job: { revision: number } }; if (change === 'source') row.source.rightsStatus = 'revoked'; else f.rows = [{ ...row, job: { ...row.job, revision: 2 } }]; }
      return { objectKey: 'private/cache.png', width: 800, height: 1200, sha256: 'b'.repeat(64) };
    });
    expect((await request()).status).toBe(change === 'role' ? 404 : 409); expect(f.outcomes).toEqual(['denied']); expect(f.sign).not.toHaveBeenCalled();
  });
});
