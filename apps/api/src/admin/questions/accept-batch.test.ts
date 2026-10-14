import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@remoa/db';
import { err, ok, questionCandidateAcceptInputSchema, questionCandidatePayloadSchema } from '@remoa/contracts';
const mocks = vi.hoisted(() => ({ recovery: vi.fn(), frozen: vi.fn(() => false), update: vi.fn() }));
vi.mock('./recovery', () => ({ recoveryState: mocks.recovery, frozenRecovery: mocks.frozen }));
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
