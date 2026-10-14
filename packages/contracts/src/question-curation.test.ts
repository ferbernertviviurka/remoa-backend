import { describe, expect, it } from 'vitest';
import {
  QUESTION_CURATION_APPROVAL_MAX, questionCurationApproveDataSchema, questionCurationApproveInputSchema,
  questionCurationApproveResultSchema, questionCurationAttributionSchema, questionCurationKeyEvidenceSchema,
  questionCurationReadinessSchema, questionCurationScopeSchema, questionCurationSourceRevisionSchema,
  questionCurationTimestampSchema, questionCurationValidationSchema,
} from './question-curation';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
const now = '2026-10-13T12:00:00.123456Z';
const key = {
  kind: 'official_final', sourceId: id(1), sourceRevisionId: id(2), answerKeyDocumentId: id(3),
  answerKeySha256: hash, examId: id(4), edition: 'Fixture edition', booklet: '01', page: 3,
  originalNumber: 1, finalityVerified: true, mappingValidated: true, annulled: false,
};
const dataset = {
  kind: 'dataset_label', sourceId: id(1), sourceRevisionId: id(2), datasetDocumentId: id(3),
  datasetFileSha256: hash, recordId: 'fixture-1', answerField: 'answer.label', labelVerified: true, mappingValidated: true,
};
const classification = {
  professionCode: 'nursing', professionVerified: true, languageTag: 'pt', languageVerified: true,
  taxonomy: { system: 'health', areaId: id(5), topicId: id(6), topicKind: 'topic', taxonomyRevision: 1 }, taxonomyVerified: true,
};
const signingScope = {
  contentHash: hash, sourceId: id(1), sourceRevisionId: id(2), origin: 'official_exam', classification,
  keyEvidence: key, explanationStatus: 'absent', integrityConfirmed: true, sourceKeyValidated: true,
};
const readiness = {
  id: id(7), revision: 1, updatedAt: now, state: 'ready', blockers: [],
  contentHash: hash, curationScopeHash: otherHash, scope: signingScope,
  sourceRevisionVerified: true, sourceRights: 'authorized', sourceRightsExpiresAt: null, asOf: now,
};
const item = { id: id(7), revision: 1, expectedContentHash: hash, expectedCurationScopeHash: otherHash, expectedSourceRevisionId: id(2), expectedUpdatedAt: now };
const request = { items: [item], idempotencyKey: id(8), reason: 'Curatorial fixture verification' };
const published = { id: id(7), outcome: 'published', version: 1, contentHash: hash, curationScopeHash: otherHash, sourceRevisionId: id(2), blockers: [] };
const revision = {
  id: id(2), sourceId: id(1), revision: 1, revisionLabel: 'fixture-v1', manifestSha256: hash,
  documents: [{ documentId: id(3), sha256: hash }],
  license: { identifier: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/', evidenceSha256: hash, scope: 'licensed_external', verified: true },
  attribution: { publisher: 'Fixture publisher', text: 'Synthetic nonclinical attribution', url: 'https://example.org/source', adaptationsDeclared: false },
  status: 'verified', verifiedAt: now,
};

describe('CCR150 / D1845 external curatorial contracts', () => {
  it('distinguishes final official key and dataset label without inventing a final exam', () => {
    expect(questionCurationKeyEvidenceSchema.parse(key).kind).toBe('official_final');
    expect(questionCurationKeyEvidenceSchema.parse(dataset).kind).toBe('dataset_label');
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...dataset, finalityVerified: true, examId: id(4) }).success).toBe(false);
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...key, correctKey: 'A' }).success).toBe(false);
  });
  it.each([0, 501, 1.5])('rejects invalid source page %s', page => {
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...key, page }).success).toBe(false);
  });
  it('preserves literal official annulment as evidence without fabricating a dataset annulment', () => {
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...key, annulled: true }).success).toBe(true);
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...dataset, annulled: true }).success).toBe(false);
  });
  it.each(['__proto__.answer', 'answer.constructor', 'prototype', '../answer', 'answer[0]'])('rejects unsafe dataset field path %s', answerField => {
    expect(questionCurationKeyEvidenceSchema.safeParse({ ...dataset, answerField }).success).toBe(false);
  });
  it('cannot claim Remoa authorship/ownership or source-swap evidence', () => {
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, origin: 'remoa_authored' }).success).toBe(false);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, sourceRevisionId: id(9) }).success).toBe(false);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, sourceId: id(9) }).success).toBe(false);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, origin: 'licensed_dataset' }).success).toBe(false);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, origin: 'licensed_dataset', keyEvidence: dataset }).success).toBe(true);
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, license: { ...revision.license, scope: 'remoa_owned' } }).success).toBe(false);
  });
  it('verified source revision needs evidence while draft stays a pending DTO', () => {
    expect(questionCurationSourceRevisionSchema.safeParse(revision).success).toBe(true);
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, verifiedAt: null }).success).toBe(false);
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, license: { ...revision.license, verified: false } }).success).toBe(false);
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, status: 'draft', verifiedAt: null, license: { ...revision.license, verified: false } }).success).toBe(true);
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, documents: [revision.documents[0], revision.documents[0]] }).success).toBe(false);
  });
  it.each(['javascript:alert(1)', 'http://example.org', 'https://user:password@example.org', 'data:text/plain,x'])('rejects unsafe attribution URL %s', url => {
    expect(questionCurationSourceRevisionSchema.safeParse({ ...revision, attribution: { ...revision.attribution, url } }).success).toBe(false);
  });
  it('public seal/attribution exclude internal evidence and never assert CRM review', () => {
    const seal = { kind: 'remoa_curation', label: 'Remoa', scope: 'source_and_answer', explanationStatus: 'absent' };
    expect(questionCurationValidationSchema.safeParse(seal).success).toBe(true);
    expect(questionCurationValidationSchema.safeParse({ ...seal, reviewerCrm: 'SP-1234' }).success).toBe(false);
    expect(questionCurationAttributionSchema.safeParse({ publisher: 'Fixture', text: 'Fixture attribution', sourceUrl: 'https://example.org', licenseIdentifier: 'CC-BY-4.0', licenseUrl: 'https://example.org/license', revisionLabel: 'v1', adaptationsDeclared: false, objectKey: 'private/document' }).success).toBe(false);
  });
  it('missing explanation remains disclosed; medical explanation status needs a real review reference', () => {
    expect(questionCurationScopeSchema.parse(signingScope).explanationStatus).toBe('absent');
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, explanationStatus: 'medical_reviewed' }).success).toBe(false);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, explanationStatus: 'medical_reviewed', explanationReviewId: id(10) }).success).toBe(true);
    expect(questionCurationScopeSchema.safeParse({ ...signingScope, explanationReviewId: id(10) }).success).toBe(false);
  });
  it('accepts ready only with all verified scope requirements', () => {
    expect(questionCurationReadinessSchema.safeParse(readiness).success).toBe(true);
    for (const patch of [{ sourceRights: 'pending' }, { sourceRights: 'restricted' }, { sourceRights: 'revoked' }, { sourceRevisionVerified: false }, { curationScopeHash: null }, { contentHash: null }, { scope: null }, { blockers: ['image_unresolved'] }])
      expect(questionCurationReadinessSchema.safeParse({ ...readiness, ...patch }).success).toBe(false);
    for (const name of ['professionVerified', 'languageVerified', 'taxonomyVerified'])
      expect(questionCurationReadinessSchema.safeParse({ ...readiness, scope: { ...signingScope, classification: { ...classification, [name]: false } } }).success).toBe(false);
    for (const name of ['integrityConfirmed', 'sourceKeyValidated'])
      expect(questionCurationReadinessSchema.safeParse({ ...readiness, scope: { ...signingScope, [name]: false } }).success).toBe(false);
    for (const name of ['finalityVerified', 'mappingValidated'])
      expect(questionCurationReadinessSchema.safeParse({ ...readiness, scope: { ...signingScope, keyEvidence: { ...key, [name]: false } } }).success).toBe(false);
  });
  it('dataset readiness verifies the label rather than an official-final flag', () => {
    const s = { ...signingScope, origin: 'licensed_dataset', keyEvidence: dataset };
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, scope: s }).success).toBe(true);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, scope: { ...s, keyEvidence: { ...dataset, labelVerified: false } } }).success).toBe(false);
  });
  it('TTL is compared without truncating microseconds at the boundary', () => {
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, sourceRightsExpiresAt: now }).success).toBe(false);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, sourceRightsExpiresAt: '2026-10-13T12:00:00.123455Z' }).success).toBe(false);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, sourceRightsExpiresAt: '2026-10-13T12:00:00.123457Z' }).success).toBe(true);
  });
  it('blocked findings remain precise, including private-data detection, without asking for generic consent', () => {
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, state: 'blocked', blockers: ['personal_data_detected', 'shared_context_unresolved'], scope: null, contentHash: null, curationScopeHash: null }).success).toBe(true);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, state: 'blocked' }).success).toBe(false);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, state: 'blocked', blockers: ['image_unresolved', 'image_unresolved'] }).success).toBe(false);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, consent: true }).success).toBe(false);
  });
  it.each(['2026-02-30T12:00:00.123456Z', '2026-10-13T24:00:00.123456Z', '2026-10-13T12:00:00.123Z', '0000-01-01T00:00:00.000000Z', '2026-10-13T12:00:00.123456+00:00'])('rejects invalid/lossy CAS timestamp %s', value => {
    expect(questionCurationTimestampSchema.safeParse(value).success).toBe(false);
  });
  it('CAS retains exact input precision and requires both clinical and curatorial hashes', () => {
    expect(questionCurationApproveInputSchema.parse(request).items[0]?.expectedUpdatedAt).toBe(now);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [{ ...item, expectedUpdatedAt: new Date(now) }] }).success).toBe(false);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [{ ...item, expectedCurationScopeHash: null }] }).success).toBe(false);
    expect(questionCurationReadinessSchema.safeParse({ ...readiness, contentHash: otherHash }).success).toBe(false);
  });
  it('caps each explicit approval at25, without duplicate ids or automatic extras', () => {
    expect(QUESTION_CURATION_APPROVAL_MAX).toBe(25);
    const items = Array.from({ length: 25 }, (_, i) => ({ ...item, id: id(100 + i) }));
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items }).success).toBe(true);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [...items, { ...item, id: id(125) }] }).success).toBe(false);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [] }).success).toBe(false);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [item, item] }).success).toBe(false);
  });
  it('approval cannot forge readonly verification flags, source data, content or actor', () => {
    for (const extra of [{ actorId: id(10) }, { integrityConfirmed: true }, { attestation: { acceptsUnconfirmedChecks: true } }, { sourceKeyValidated: true }, { stem: 'Injected content' }])
      expect(questionCurationApproveInputSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, items: [{ ...item, sourceRevisionId: id(9) }] }).success).toBe(false);
    expect(questionCurationApproveInputSchema.safeParse({ ...request, reason: 'short' }).success).toBe(false);
  });
  it('replay exposes only stored signed outcomes and requires the existing audit wrapper', () => {
    expect(questionCurationApproveDataSchema.safeParse({ replayed: true, results: [published] }).success).toBe(true);
    expect(questionCurationApproveResultSchema.safeParse({ replayed: true, results: [published] }).success).toBe(false);
    expect(questionCurationApproveDataSchema.safeParse({ replayed: false, results: [{ ...published, curationScopeHash: null }] }).success).toBe(false);
    expect(questionCurationApproveDataSchema.safeParse({ replayed: true, results: [published, published] }).success).toBe(false);
    expect(questionCurationApproveDataSchema.safeParse({ replayed: false, results: [{ ...published, outcome: 'blocked', blockers: [] }] }).success).toBe(false);
    expect(questionCurationApproveDataSchema.safeParse({ replayed: false, results: [{ ...published, outcome: 'blocked', blockers: ['key_ambiguous'] }] }).success).toBe(true);
  });
});
