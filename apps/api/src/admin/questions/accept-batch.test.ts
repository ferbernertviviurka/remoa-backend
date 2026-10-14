import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@remoa/db';
import { err, ok, questionCandidateAcceptInputSchema, questionCandidatePayloadSchema } from '@remoa/contracts';
const mocks = vi.hoisted(() => ({ recovery: vi.fn(), frozen: vi.fn(() => false), update: vi.fn() }));
vi.mock('./recovery', () => ({ recoveryState: mocks.recovery, frozenRecovery: (s: { frozen?: boolean }) => mocks.frozen() || Boolean(s.frozen) }));
vi.mock('./service', () => ({ updateCandidate: mocks.update }));
import { acceptCandidates } from './accept-batch';

const importId = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()];
const payload = questionCandidatePayloadSchema.parse({ stem: 'Conteúdo autoral sintético', alternatives: [{ key: 'A', text: 'Primeira' }, { key: 'B', text: 'Segunda' }],
  correctKey: 'A', annulled: false, areaId: randomUUID(), topicId: randomUUID(), imageRefs: [], assets: [] });
const input = (count = 2) => questionCandidateAcceptInputSchema.parse({ importRevision: 7,
  items: ids.slice(0, count).map(id => ({ id, revision: 0 })), confirmsChecks: true, reason: 'Conferência sintética do lote' });
const tx = { transaction: async (fn: (sp: Tx) => Promise<unknown>) => fn({} as Tx) } as unknown as Tx;
const audit = () => ({ before: vi.fn(), after: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.frozen.mockReturnValue(false);
  mocks.recovery.mockResolvedValue(ok({ contexts: [], candidates: ids.map(id => ({ id, revision: 0, state: 'needs_review', issues: [], payload })) }));
});
describe('accept batch preserves actual import revision / per-item savepoint conflicts', () => {
  it('advances next item CAS from returned revision and returns final revision', async () => {
    mocks.update.mockResolvedValueOnce(ok({ candidate: {}, questionId: ids[0], importRevision: 8 }))
      .mockResolvedValueOnce(ok({ candidate: {}, questionId: ids[1], importRevision: 9 }));
    const log = audit();
    const result = await acceptCandidates(tx, importId, input(), log);
    expect(result).toEqual(ok({ results: [{ id: ids[0], outcome: 'accepted', questionId: ids[0] },
      { id: ids[1], outcome: 'accepted', questionId: ids[1] }], importRevision: 9 }));
    expect(mocks.update.mock.calls.map(call => call[3].importRevision)).toEqual([7, 8]);
    expect(log.after).toHaveBeenCalledOnce();
    expect(log.after.mock.calls[0]?.[0]).toMatchObject({ importRevision: 9 });
  });
  it.each([undefined, null, '8', NaN, Infinity, 7, 9, 8.5])('missing/malformed/nonsequential actual revision %s is conflict, never invented', async importRevision => {
    const saved = { candidate: {}, questionId: ids[0], ...(importRevision === undefined ? {} : { importRevision }) };
    mocks.update.mockResolvedValue(ok(saved));
    const result = await acceptCandidates(tx, importId, input(1), audit());
    expect(result).toEqual(ok({ results: [{ id: ids[0], outcome: 'conflict', questionId: null }], importRevision: 7 }));
  });
  it('failed middle item keeps previous committed revision for next item', async () => {
    mocks.update.mockResolvedValueOnce(ok({ candidate: {}, questionId: ids[0], importRevision: 8 }))
      .mockResolvedValueOnce(err('conflict', 'candidate_or_import_revision_changed'))
      .mockResolvedValueOnce(ok({ candidate: {}, questionId: ids[2], importRevision: 9 }));
    const result = await acceptCandidates(tx, importId, input(3), audit());
    expect(result.ok && result.data.importRevision).toBe(9);
    expect(result.ok && result.data.results.map(r => r.outcome)).toEqual(['accepted', 'conflict', 'accepted']);
    expect(mocks.update.mock.calls.map(call => call[3].importRevision)).toEqual([7, 8, 8]);
  });
  it('initial import conflict or frozen graph never calls updateCandidate', async () => {
    mocks.recovery.mockResolvedValueOnce(err('conflict', 'import_revision_changed'));
    expect(await acceptCandidates(tx, importId, input(), audit())).toEqual(err('conflict', 'import_revision_changed'));
    mocks.frozen.mockReturnValueOnce(true);
    expect(await acceptCandidates(tx, importId, input(), audit())).toEqual(err('conflict', 'published_requires_new_version'));
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

// Preserve the PR's complete per-item and whole-call gate coverage alongside main's revision guards.
describe('D-1841 batch accept (PR coverage)', () => {
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const area = id(90), topic = id(91);
const payload = { stem: 'Enunciado sintético', alternatives: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctKey: 'A', annulled: false, areaId: area, topicId: topic };
const cand = (n: number, over: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({ id: id(n), state: 'needs_review', revision: 0, issues: [], payload: { ...payload, ...p }, ...over });
const tx = { transaction: (fn: (sp: unknown) => unknown) => fn('sp') } as never;
const audit = { before: vi.fn(), after: vi.fn() };
const input = (ids: number[]) => questionCandidateAcceptInputSchema.parse({ importRevision: 3, items: ids.map((n) => ({ id: id(n), revision: 0 })), confirmsChecks: true, reason: 'Conferi a prova sintética' });

  it('accepts eligible items through updateCandidate, threads the import revision and reports each failure', async () => {
    mocks.recovery.mockResolvedValue(ok({ contexts: [], candidates: [
      cand(1), cand(2, { state: 'accepted' }), cand(3, { state: 'rejected' }), cand(4, { revision: 7 }), cand(5, { issues: ['number'] }),
      cand(6, {}, { areaId: null }), cand(7, {}, { correctKey: 'Z' }), cand(8, {}, { imageRefs: [{ objectKey: 'k', page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, method: 'ocr' }] }), cand(9), cand(10),
    ] }));
    mocks.update.mockResolvedValueOnce(ok({ questionId: id(101), importRevision: 4 })).mockResolvedValueOnce(err('conflict', 'x')).mockResolvedValueOnce(ok({ questionId: id(110), importRevision: 5 }));
    const r = await acceptCandidates(tx, id(0), input([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), audit);
    expect(r.ok && r.data.results.map((x) => x.outcome)).toEqual(['accepted', 'already_accepted', 'not_pending', 'conflict', 'has_issues', 'taxonomy_missing', 'answer_key_missing', 'needs_images', 'conflict', 'accepted', 'not_found']);
    expect(r.ok && r.data.importRevision).toBe(5);
    expect(mocks.update.mock.calls.map((c) => [c[2], c[3].importRevision, c[3].state, c[3].keyFinal, c[3].integrityConfirmed])).toEqual([
      [id(1), 3, 'accepted', true, true], [id(9), 4, 'accepted', true, true], [id(10), 4, 'accepted', true, true],
    ]);
    expect(audit.after).toHaveBeenCalledTimes(1);
  });

  it('refuses the whole call on frozen paper or unresolved shared context', async () => {
    mocks.recovery.mockResolvedValueOnce(ok({ frozen: true, contexts: [], candidates: [] }));
    expect(await acceptCandidates(tx, id(0), input([1]), audit)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    mocks.recovery.mockResolvedValueOnce(ok({ contexts: [{ status: 'unresolved' }], candidates: [] }));
    expect(await acceptCandidates(tx, id(0), input([1]), audit)).toMatchObject({ ok: false, error: { message: 'shared_context_resolution_required' } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('requires the attestation and unique ids', () => {
    expect(questionCandidateAcceptInputSchema.safeParse({ importRevision: 0, items: [{ id: id(1), revision: 0 }], confirmsChecks: false, reason: 'Motivo suficiente' }).success).toBe(false);
    expect(questionCandidateAcceptInputSchema.safeParse({ importRevision: 0, items: [{ id: id(1), revision: 0 }, { id: id(1), revision: 0 }], confirmsChecks: true, reason: 'Motivo suficiente' }).success).toBe(false);
  });
});
