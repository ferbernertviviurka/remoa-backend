import { QUESTION_CONTENT_HASH_VERSION, questionAdminOutboxPageSchema, questionInstitutionalApproveResultSchema, questionGenerationMetricsSchema, questionHashPrepareResultSchema, questionOutboxRecoverResultSchema } from '../question-operations';
/** Synthetic engineering fixtures (D-1804/D-1805): ids, hashes and counts only, no content. */
const id = '33000000-0000-4000-8000-000000000001';
const createdAt = '2026-10-12T12:00:00.000Z';
const audit = (action: string, targetType: string, targetId: string) => ({ id: 1, createdAt, actorType: 'admin', actor: null, action, targetType, targetId, targetLabel: null, reason: 'Preparação sintética auditada', result: 'success', denial: null, before: null, after: null, ipHash: null, userAgent: null, requestId: null });
export const mockQuestionHashPrepareResult = questionHashPrepareResultSchema.parse({ hashVersion: QUESTION_CONTENT_HASH_VERSION, replayed: false, results: [
  { id, outcome: 'prepared', version: 1, contentHash: 'a'.repeat(64), sourceId: null },
  { id: '33000000-0000-4000-8000-000000000002', outcome: 'conflict', version: 2, contentHash: null, sourceId: null },
], audit: audit('question.content_hash_prepare', 'question_batch', id) });
const outboxItem = { outboxId: id, runId: id, ownerId: id, producer: 'challenge_objective', target: 'question-receipt', state: 'exhausted', attempts: 20, attemptLimit: 20, errorCode: 'provider_receipt_missing', createdAt, updatedAt: createdAt, deliveredAt: null };
export const mockQuestionAdminOutboxPage = questionAdminOutboxPageSchema.parse({ items: [outboxItem], nextCursor: null, audit: audit('question.generation_view', 'route', '/v1/admin/questions/generation/outbox') });
export const mockQuestionOutboxRecoverResult = questionOutboxRecoverResultSchema.parse({ replayed: false, results: [{ outboxId: id, outcome: 'granted', granted: 2, attempts: 20, attemptLimit: 22 }], audit: audit('question.generation_recover', 'question_outbox', id) });
export const mockQuestionGenerationMetrics = questionGenerationMetricsSchema.parse({ generatedAt: createdAt, windowHours: 24,
  backlog: [{ target: 'question-receipt', pending: 0, leased: 0, exhausted: 1, oldestPendingAt: null }, { target: 'question-promotion', pending: 0, leased: 0, exhausted: 0, oldestPendingAt: null }],
  throughput: [{ target: 'question-receipt', delivered: 0, recovered: 0 }, { target: 'question-promotion', delivered: 0, recovered: 0 }],
  cost: { runs: 10, runsWithKnownCost: 0, runsWithUnknownCost: 10, knownCostCents: 0 }, audit: audit('question.generation_view', 'route', '/v1/admin/questions/generation/metrics') });
export const mockQuestionInstitutionalApproveResult = questionInstitutionalApproveResultSchema.parse({ replayed: false, sourceId: '33000000-0000-4000-8000-000000000009', results: [
  { id, outcome: 'published', version: 1, contentHash: 'a'.repeat(64) },
  { id: '33000000-0000-4000-8000-000000000002', outcome: 'answer_key_missing', version: 1, contentHash: 'b'.repeat(64) },
  { id: '33000000-0000-4000-8000-000000000003', outcome: 'hash_missing', version: 1, contentHash: null },
], audit: audit('question.institutional_approve', 'question_batch', id) });
