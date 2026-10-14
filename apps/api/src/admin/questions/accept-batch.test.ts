import { describe, expect, it, vi, beforeEach } from 'vitest';
import { err, ok, questionCandidateAcceptInputSchema } from '@remoa/contracts';

const m = vi.hoisted(() => ({ state: vi.fn(), update: vi.fn() }));
vi.mock('./recovery', () => ({ recoveryState: m.state, frozenRecovery: (s: { frozen?: boolean }) => Boolean(s.frozen) }));
vi.mock('./service', () => ({ updateCandidate: m.update }));
const { acceptCandidates } = await import('./accept-batch');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const area = id(90), topic = id(91);
const payload = { stem: 'Enunciado sintético', alternatives: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctKey: 'A', annulled: false, areaId: area, topicId: topic };
const cand = (n: number, over: Record<string, unknown> = {}, p: Record<string, unknown> = {}) => ({ id: id(n), state: 'needs_review', revision: 0, issues: [], payload: { ...payload, ...p }, ...over });
const tx = { transaction: (fn: (sp: unknown) => unknown) => fn('sp') } as never;
const audit = { before: vi.fn(), after: vi.fn() };
const input = (ids: number[]) => questionCandidateAcceptInputSchema.parse({ importRevision: 3, items: ids.map((n) => ({ id: id(n), revision: 0 })), confirmsChecks: true, reason: 'Conferi a prova sintética' });

beforeEach(() => vi.clearAllMocks());

describe('D-1841 batch accept', () => {
  it('accepts eligible items through updateCandidate, threads the import revision and reports each failure', async () => {
    m.state.mockResolvedValue(ok({ contexts: [], candidates: [
      cand(1), cand(2, { state: 'accepted' }), cand(3, { state: 'rejected' }), cand(4, { revision: 7 }), cand(5, { issues: ['number'] }),
      cand(6, {}, { areaId: null }), cand(7, {}, { correctKey: 'Z' }), cand(8, {}, { imageRefs: [{ objectKey: 'k', page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, method: 'ocr' }] }), cand(9), cand(10),
    ] }));
    m.update.mockResolvedValueOnce(ok({ questionId: id(101), importRevision: 4 })).mockResolvedValueOnce(err('conflict', 'x')).mockResolvedValueOnce(ok({ questionId: id(110), importRevision: 5 }));
    const r = await acceptCandidates(tx, id(0), input([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), audit);
    expect(r.ok && r.data.results.map((x) => x.outcome)).toEqual(['accepted', 'already_accepted', 'not_pending', 'conflict', 'has_issues', 'taxonomy_missing', 'answer_key_missing', 'needs_images', 'conflict', 'accepted', 'not_found']);
    expect(r.ok && r.data.importRevision).toBe(5);
    expect(m.update.mock.calls.map((c) => [c[2], c[3].importRevision, c[3].state, c[3].keyFinal, c[3].integrityConfirmed])).toEqual([
      [id(1), 3, 'accepted', true, true], [id(9), 4, 'accepted', true, true], [id(10), 4, 'accepted', true, true],
    ]);
    expect(audit.after).toHaveBeenCalledTimes(1);
  });

  it('refuses the whole call on frozen paper or unresolved shared context', async () => {
    m.state.mockResolvedValueOnce(ok({ frozen: true, contexts: [], candidates: [] }));
    expect(await acceptCandidates(tx, id(0), input([1]), audit)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    m.state.mockResolvedValueOnce(ok({ contexts: [{ status: 'unresolved' }], candidates: [] }));
    expect(await acceptCandidates(tx, id(0), input([1]), audit)).toMatchObject({ ok: false, error: { message: 'shared_context_resolution_required' } });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('requires the attestation and unique ids', () => {
    expect(questionCandidateAcceptInputSchema.safeParse({ importRevision: 0, items: [{ id: id(1), revision: 0 }], confirmsChecks: false, reason: 'Motivo suficiente' }).success).toBe(false);
    expect(questionCandidateAcceptInputSchema.safeParse({ importRevision: 0, items: [{ id: id(1), revision: 0 }, { id: id(1), revision: 0 }], confirmsChecks: true, reason: 'Motivo suficiente' }).success).toBe(false);
  });
});
