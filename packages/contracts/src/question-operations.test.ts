import { describe, expect, it } from 'vitest';
import { adminActions, auditTargetTypes } from './admin';
import { questionAdminCatalogQuerySchema } from './question-admin-catalog';
import { QUESTION_HASH_PREPARE_MAX, questionAdminOutboxItemSchema, questionGenerationMetricsSchema, questionHashPrepareInputSchema, questionOutboxItemSchema, questionOutboxRecoverInputSchema, questionOutboxRecoverItemResultSchema } from './question-operations';
import { mockQuestionGenerationMetrics, mockQuestionHashPrepareResult, mockQuestionOutboxRecoverResult } from './mocks/question-operations';

const id = (n: number) => `33000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reason = 'Preparação sintética auditada';
const item = (n: number) => ({ id: id(n), revision: 1, expectedUpdatedAt: '2026-10-12T12:00:00.000Z' });

describe('D-1804 content-hash preparation', () => {
  const base = { items: [item(1)], idempotencyKey: id(9), reason };
  it('accepts 1..500 unique items and bounds the batch', () => {
    expect(questionHashPrepareInputSchema.parse(base).sourceId).toBeNull();
    expect(questionHashPrepareInputSchema.safeParse({ ...base, items: Array.from({ length: QUESTION_HASH_PREPARE_MAX }, (_, i) => item(i + 1)) }).success).toBe(true);
    for (const items of [[], Array.from({ length: QUESTION_HASH_PREPARE_MAX + 1 }, (_, i) => item(i + 1)), [item(1), item(1)]])
      expect(questionHashPrepareInputSchema.safeParse({ ...base, items }).success).toBe(false);
  });
  it('requires reason >= 8, uuid idempotency key, revision and timestamp', () => {
    for (const bad of [{ reason: 'curto' }, { idempotencyKey: 'abc' }, { items: [{ id: id(1), revision: 0, expectedUpdatedAt: '2026-10-12T12:00:00.000Z' }] }, { items: [{ id: id(1), revision: 1 }] }])
      expect(questionHashPrepareInputSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });
  it('cannot carry content, rights, review, integrity, key, taxonomy or publication', () => {
    for (const extra of [{ contentHash: 'a'.repeat(64) }, { rightsStatus: 'authorized' }, { reviewedHash: 'a'.repeat(64) }, { integrityConfirmed: true }, { keyFinal: true }, { correctKey: 'A' }, { topicId: id(2) }, { catalogStatus: 'published' }, { stem: 'x' }])
      expect(questionHashPrepareInputSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(questionHashPrepareInputSchema.safeParse({ ...base, items: [{ ...item(1), contentHash: 'a'.repeat(64) }] }).success).toBe(false);
  });
  it('mock result is strict and names the canonical algorithm', () => {
    expect(mockQuestionHashPrepareResult.hashVersion).toBe('f33-content-v2-jsonb-assets');
    expect(questionAdminCatalogQuerySchema.parse({ hashState: 'missing' }).hashState).toBe('missing');
  });
  it('registers audit action and batch target', () => {
    expect(adminActions).toEqual(expect.arrayContaining(['question.content_hash_prepare', 'question.generation_view', 'question.generation_recover']));
    expect(auditTargetTypes).toEqual(expect.arrayContaining(['question_batch', 'question_outbox']));
  });
});

describe('D-1805 / CCR144 outbox recovery', () => {
  const base = { items: [{ outboxId: id(1), expectedAttempts: 20, expectedAttemptLimit: 20 }], extraAttempts: 5, idempotencyKey: id(9), reason };
  it('grants at most 5 extras within a 20..25 lifetime budget', () => {
    expect(questionOutboxRecoverInputSchema.safeParse(base).success).toBe(true);
    for (const bad of [{ extraAttempts: 0 }, { extraAttempts: 6 }, { items: [{ ...base.items[0], expectedAttemptLimit: 26 }] }, { items: [{ ...base.items[0], expectedAttemptLimit: 19 }] }, { items: [base.items[0], base.items[0]] }, { items: [] }, { reason: 'x' }])
      expect(questionOutboxRecoverInputSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });
  it('outcome and granted amount agree', () => {
    expect(questionOutboxRecoverItemResultSchema.safeParse({ outboxId: id(1), outcome: 'granted', granted: 0, attempts: 20, attemptLimit: 20 }).success).toBe(false);
    expect(questionOutboxRecoverItemResultSchema.safeParse({ outboxId: id(1), outcome: 'limit_reached', granted: 1, attempts: 25, attemptLimit: 25 }).success).toBe(false);
    expect(mockQuestionOutboxRecoverResult.results[0]!.attemptLimit).toBe(22);
  });
  it('lists expose no object key, URL, prompt or content; owner list has no ownerId and discovery is not a target', () => {
    const row = { outboxId: id(1), runId: id(2), producer: 'challenge_objective', target: 'question-receipt', state: 'exhausted', attempts: 20, attemptLimit: 20, errorCode: null, createdAt: new Date(), updatedAt: new Date(), deliveredAt: null };
    expect(questionOutboxItemSchema.safeParse(row).success).toBe(true);
    for (const extra of [{ payloadReference: 'questions/generation/x/receipt.json' }, { url: 'https://example.invalid' }, { prompt: 'x' }, { stem: 'x' }, { ownerId: id(3) }])
      expect(questionOutboxItemSchema.safeParse({ ...row, ...extra }).success).toBe(false);
    expect(questionOutboxItemSchema.safeParse({ ...row, target: 'question-promotion-discovery' }).success).toBe(false);
    expect(questionOutboxItemSchema.safeParse({ ...row, errorCode: 'Free text with spaces' }).success).toBe(false);
    expect(questionAdminOutboxItemSchema.safeParse({ ...row, ownerId: id(3) }).success).toBe(true);
  });
  it('zero historical cost is unknown, never free', () => {
    expect(mockQuestionGenerationMetrics.cost.runsWithUnknownCost).toBe(10);
    expect(questionGenerationMetricsSchema.safeParse({ ...mockQuestionGenerationMetrics, cost: { runs: 10, runsWithKnownCost: 0, runsWithUnknownCost: 0, knownCostCents: 0 } }).success).toBe(false);
  });
});
