import { describe, expect, it, vi } from 'vitest';
import { err } from '@remoa/contracts';
import type { Context } from 'hono';
import type { Env } from '../../app';
const f = vi.hoisted(() => ({ select: vi.fn(), events: [] as string[] }));
vi.mock('./recovery', () => ({ lockAssociatedQuestionGraphs: vi.fn(async () => {
  f.events.push('graph');
  return err('conflict', 'question_graph_changed_retry');
}) }));
vi.mock('../../db', () => ({ dbm: async () => ({
  profiles: { userId: 'userId' },
  db: {
    select: () => ({ from: () => ({ where: async () => [{ role: 'reviewer', name: 'Authorial Reviewer', crm: '12345-SP' }] }) }),
    transaction: async (run: (tx: unknown) => unknown) => run({ select: f.select }),
  },
}) }));
import { recordMedicalReview } from '../../questions/editorial/service';
describe('medical review graph lock order', () => {
  it('stops a changed graph before selecting or locking the question and before signing', async () => {
    const c = { get: () => '00000000-0000-4000-8000-000000000001' } as unknown as Context<Env>;
    const result = await recordMedicalReview(c, '00000000-0000-4000-8000-000000000002', {
      contentHash: 'a'.repeat(64), decision: 'rejected', reason: 'Authorial lock conflict verification', referenceDate: '2026-10-09',
    });
    expect(result).toMatchObject({ ok: false, error: { message: 'question_graph_changed_retry' } });
    expect(f.events).toEqual(['graph']);
    expect(f.select).not.toHaveBeenCalled();
  });
});
