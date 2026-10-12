import { describe, expect, it } from 'vitest';
import { adminActions } from './admin';
import { questionLatestReviewSchema, questionPublicSchema, questionReferenceAfterAnswerSchema, questionSourceInputSchema, questionValidationSchema } from './question-catalog';
import { QUESTION_INSTITUTIONAL_APPROVE_MAX, questionInstitutionalApproveInputSchema, questionInstitutionalApproveOutcomes } from './question-operations';
import { mockQuestionInstitutionalApproveResult } from './mocks/question-operations';

const id = (n: number) => `33000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number) => ({ id: id(n), revision: 1, expectedContentHash: 'a'.repeat(64) });
const attestation = { approverRole: 'medical_founder', approverName: 'Fundadora Sintética', rightsBasis: 'remoa_owned', acceptsUnconfirmedChecks: true };
const base = { items: [item(1)], attestation, idempotencyKey: id(9), reason: 'Aprovação institucional sintética' };

describe('D-1819 institutional approval input', () => {
  it('accepts 1..500 unique items with hash CAS', () => {
    expect(questionInstitutionalApproveInputSchema.safeParse(base).success).toBe(true);
    expect(questionInstitutionalApproveInputSchema.safeParse({ ...base, items: Array.from({ length: QUESTION_INSTITUTIONAL_APPROVE_MAX }, (_, i) => item(i + 1)) }).success).toBe(true);
    for (const items of [[], Array.from({ length: QUESTION_INSTITUTIONAL_APPROVE_MAX + 1 }, (_, i) => item(i + 1)), [item(1), item(1)], [{ id: id(1), revision: 1 }], [{ ...item(1), expectedContentHash: 'x' }]])
      expect(questionInstitutionalApproveInputSchema.safeParse({ ...base, items }).success).toBe(false);
  });
  it('requires the founder attestation, Remoa-owned rights and explicit acceptance; never a CRM', () => {
    for (const bad of [{ approverRole: 'reviewer' }, { rightsBasis: 'authorized' }, { acceptsUnconfirmedChecks: false }, { approverName: 'Dra X CRM 12345-SP' }, { approverName: 'ab' }, { crm: '123-SP' }])
      expect(questionInstitutionalApproveInputSchema.safeParse({ ...base, attestation: { ...attestation, ...bad } }).success).toBe(false);
    for (const bad of [{ reason: 'curto' }, { idempotencyKey: 'abc' }, { correctKey: 'A' }, { sourceId: id(3) }, { stem: 'x' }])
      expect(questionInstitutionalApproveInputSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });
  it('outcomes include the hard answer-key gate and mock is strict', () => {
    expect(questionInstitutionalApproveOutcomes).toEqual(expect.arrayContaining(['published', 'already_published', 'not_eligible', 'conflict', 'answer_key_missing', 'hash_missing', 'not_found']));
    expect(mockQuestionInstitutionalApproveResult.results.map((r) => r.outcome)).toContain('answer_key_missing');
    expect(adminActions).toContain('question.institutional_approve');
  });
});

describe('D-1819 public validation seal', () => {
  it('institutional seal is "Remoa" with no CRM; medical seal carries a name', () => {
    expect(questionValidationSchema.safeParse({ kind: 'remoa_institutional', label: 'Remoa' }).success).toBe(true);
    expect(questionValidationSchema.safeParse({ kind: 'remoa_institutional', label: 'Dra. X' }).success).toBe(false);
    expect(questionValidationSchema.safeParse({ kind: 'remoa_institutional', label: 'Remoa', crm: '1-SP' }).success).toBe(false);
    expect(questionValidationSchema.safeParse({ kind: 'medical_review', label: 'Dra. Revisora' }).success).toBe(true);
    expect(questionPublicSchema.shape.validation.safeParse(null).success).toBe(true);
  });
  it('reference after answer and latest review never pair institutional with a CRM', () => {
    const ref = { questionId: id(1), version: 1, correctKey: 'A', explanation: 'x', distractorNotes: null, annulled: false, reviewed: true, reviewerName: null, reviewerCrm: null, referenceDate: '2026-10-12', sourceUrl: null, obsolete: false, validation: { kind: 'remoa_institutional', label: 'Remoa' } };
    expect(questionReferenceAfterAnswerSchema.safeParse(ref).success).toBe(true);
    expect(questionReferenceAfterAnswerSchema.safeParse({ ...ref, reviewerCrm: '1-SP' }).success).toBe(false);
    const review = { decision: 'approved', contentHash: 'a'.repeat(64), reviewerName: 'Fundadora', referenceDate: '2026-10-12', reviewedAt: '2026-10-12T12:00:00.000Z' };
    expect(questionLatestReviewSchema.safeParse({ ...review, kind: 'remoa_institutional', reviewerCrm: null }).success).toBe(true);
    expect(questionLatestReviewSchema.safeParse({ ...review, kind: 'remoa_institutional', reviewerCrm: '1-SP' }).success).toBe(false);
    expect(questionLatestReviewSchema.safeParse({ ...review, reviewerCrm: null }).success).toBe(false);
    expect(questionLatestReviewSchema.safeParse({ ...review, reviewerCrm: '1-SP' }).success).toBe(true);
  });
  it('generic source endpoint cannot claim the reserved remoa_owned scope', () => {
    expect(questionSourceInputSchema.safeParse({ name: 'x', publisher: 'x', url: 'https://example.org', rightsScope: 'remoa_owned', reason: 'fixture testing' }).success).toBe(false);
  });
});
