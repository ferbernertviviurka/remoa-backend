/**
 * G28 / CCR150 / D1845: approved external-curation design, local contracts only.
 * Server evidence, source rights, lineage and scope hashes must be rechecked in the same audited transaction.
 * Existing medical_review/remoa_institutional and current withAdmin authentication policy remain unchanged.
 */
import { z } from 'zod';
import { idSchema } from './common';
import { auditEntrySchema, reasonSchema } from './admin';
import { healthQuestionClassificationSchema } from './health-taxonomy';

export const QUESTION_CURATION_APPROVAL_MAX = 25 as const;
export const questionCurationOrigins = ['official_exam', 'licensed_dataset'] as const;
export const questionCurationExplanationStatuses = ['absent', 'source_provided', 'remoa_curated', 'medical_reviewed'] as const;
export const questionCurationHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Preserve microseconds for CAS; never coerce through Date (which truncates them). UTC wire format only. */
export const questionCurationTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine(value => {
    const date = new Date(value);
    return value.slice(0, 4) !== '0000' && !Number.isNaN(date.getTime()) &&
      date.toISOString() === value.slice(0, 23) + 'Z';
  }, 'invalid_calendar_timestamp');
const httpsUrl = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'https_without_credentials_required');
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const fileEvidence = z.object({ documentId: idSchema, sha256: questionCurationHashSchema }).strict();
const scope = z.object({ sourceId: idSchema, sourceRevisionId: idSchema }).strict();

/** Private admin evidence DTO; hashes/actors/object paths are not included in public attribution. */
export const questionCurationSourceRevisionSchema = z.object({
  id: idSchema, sourceId: idSchema, revision: z.number().int().positive(),
  revisionLabel: z.string().trim().min(1).max(200), manifestSha256: questionCurationHashSchema,
  documents: z.array(fileEvidence).min(1).max(200)
    .refine(value => unique(value.map(item => item.documentId)), 'duplicate_document_ids'),
  license: z.object({
    identifier: z.string().trim().min(1).max(80), url: httpsUrl,
    evidenceSha256: questionCurationHashSchema,
    scope: z.literal('licensed_external'), verified: z.boolean(),
  }).strict(),
  attribution: z.object({
    publisher: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(4000),
    url: httpsUrl, adaptationsDeclared: z.boolean(),
  }).strict(),
  status: z.enum(['draft', 'verified', 'withdrawn']), verifiedAt: questionCurationTimestampSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'verified' && (!value.license.verified || value.verifiedAt === null))
    ctx.addIssue({ code: 'custom', message: 'verified_revision_requires_license_evidence' });
});
export type QuestionCurationSourceRevision = z.infer<typeof questionCurationSourceRevisionSchema>;

/** Evidence references only: no correct letter, free-form label, raw record, URL or storage object key. */
export const questionCurationKeyEvidenceSchema = z.discriminatedUnion('kind', [
  scope.extend({
    kind: z.literal('official_final'), answerKeyDocumentId: idSchema,
    answerKeySha256: questionCurationHashSchema, examId: idSchema,
    edition: z.string().trim().min(1).max(200), booklet: z.string().trim().min(1).max(100),
    page: z.number().int().min(1).max(500), originalNumber: z.number().int().min(1).max(999),
    finalityVerified: z.boolean(), mappingValidated: z.boolean(),
    annulled: z.boolean(),
  }).strict(),
  scope.extend({
    kind: z.literal('dataset_label'), datasetDocumentId: idSchema,
    datasetFileSha256: questionCurationHashSchema,
    recordId: z.string().trim().min(1).max(200),
    answerField: z.string().min(1).max(200).regex(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/)
      .refine(value => !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), 'unsafe_field_path'),
    labelVerified: z.boolean(), mappingValidated: z.boolean(),
  }).strict(),
]);
export type QuestionCurationKeyEvidence = z.infer<typeof questionCurationKeyEvidenceSchema>;

/** Source-and-answer curatorial seal has no medical claim or CRM. Explanation status is an explicit disclosure. */
export const questionCurationValidationSchema = z.object({
  kind: z.literal('remoa_curation'), label: z.literal('Remoa'),
  scope: z.literal('source_and_answer'), explanationStatus: z.enum(questionCurationExplanationStatuses),
}).strict();
export const questionCurationAttributionSchema = z.object({
  publisher: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(4000),
  sourceUrl: httpsUrl, licenseIdentifier: z.string().trim().min(1).max(80), licenseUrl: httpsUrl,
  revisionLabel: z.string().trim().min(1).max(200), adaptationsDeclared: z.boolean(),
}).strict();

/** Private signing input snapshot; backend computes its canonical scope hash, never trusts a client-computed hash. */
export const questionCurationScopeSchema = z.object({
  contentHash: questionCurationHashSchema, sourceId: idSchema, sourceRevisionId: idSchema,
  origin: z.enum(questionCurationOrigins), classification: healthQuestionClassificationSchema,
  keyEvidence: questionCurationKeyEvidenceSchema,
  explanationStatus: z.enum(questionCurationExplanationStatuses),
  /** Only a real, separately authorized medical review can support this explanation status. */
  explanationReviewId: idSchema.nullable().default(null),
  integrityConfirmed: z.boolean(), sourceKeyValidated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.keyEvidence.sourceId !== value.sourceId || value.keyEvidence.sourceRevisionId !== value.sourceRevisionId)
    ctx.addIssue({ code: 'custom', path: ['keyEvidence'], message: 'key_evidence_source_mismatch' });
  if ((value.origin === 'official_exam') !== (value.keyEvidence.kind === 'official_final'))
    ctx.addIssue({ code: 'custom', path: ['keyEvidence'], message: 'key_evidence_origin_mismatch' });
  if ((value.explanationStatus === 'medical_reviewed') !== (value.explanationReviewId !== null))
    ctx.addIssue({ code: 'custom', path: ['explanationReviewId'], message: 'medical_explanation_requires_review' });
});
export type QuestionCurationScope = z.infer<typeof questionCurationScopeSchema>;

export const questionCurationBlockerCodes = [
  'not_eligible', 'hash_missing', 'content_hash_changed', 'source_missing', 'source_revision_changed',
  'license_unverified', 'rights_pending', 'rights_restricted', 'rights_revoked', 'rights_expired',
  'language_unverified', 'profession_unverified', 'taxonomy_unverified', 'taxonomy_mismatch',
  'key_missing', 'key_ambiguous', 'key_mapping_unverified', 'key_not_final', 'integrity_pending',
  'shared_context_unresolved', 'image_unresolved', 'personal_data_detected', 'explanation_state_invalid',
] as const;
/** Server-generated readiness, never a review/approval input or a general privacy-consent form. */
export const questionCurationReadinessSchema = z.object({
  id: idSchema, revision: z.number().int().positive(), updatedAt: questionCurationTimestampSchema,
  state: z.enum(['ready', 'blocked']),
  blockers: z.array(z.enum(questionCurationBlockerCodes)).max(questionCurationBlockerCodes.length)
    .refine(unique, 'duplicate_blockers'),
  contentHash: questionCurationHashSchema.nullable(), curationScopeHash: questionCurationHashSchema.nullable(),
  scope: questionCurationScopeSchema.nullable(),
  sourceRevisionVerified: z.boolean(), sourceRights: z.enum(['pending', 'authorized', 'restricted', 'revoked']),
  sourceRightsExpiresAt: questionCurationTimestampSchema.nullable(),
  asOf: questionCurationTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.state === 'blocked' && value.blockers.length === 0)
    ctx.addIssue({ code: 'custom', path: ['blockers'], message: 'blocked_requires_reason' });
  if (value.scope && value.contentHash !== value.scope.contentHash)
    ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'scope_content_hash_mismatch' });
  if (value.state !== 'ready') return;
  const s = value.scope;
  if (value.blockers.length || !value.contentHash || !value.curationScopeHash || !s ||
      !value.sourceRevisionVerified || value.sourceRights !== 'authorized' ||
      (value.sourceRightsExpiresAt !== null && value.sourceRightsExpiresAt <= value.asOf) ||
      !s.integrityConfirmed || !s.sourceKeyValidated || !s.classification.professionVerified ||
      !s.classification.languageVerified || !s.classification.taxonomyVerified || !s.keyEvidence.mappingValidated ||
      (s.keyEvidence.kind === 'official_final' ? !s.keyEvidence.finalityVerified : !s.keyEvidence.labelVerified))
    ctx.addIssue({ code: 'custom', message: 'ready_requires_verified_scope' });
});
export type QuestionCurationReadiness = z.infer<typeof questionCurationReadinessSchema>;

export const questionCurationApproveItemSchema = z.object({
  id: idSchema, revision: z.number().int().positive(),
  expectedContentHash: questionCurationHashSchema, expectedCurationScopeHash: questionCurationHashSchema,
  expectedSourceRevisionId: idSchema, expectedUpdatedAt: questionCurationTimestampSchema,
}).strict();
/** Audited approval only. Reuse current withAdmin policy; does not introduce another recent-login window or accept readonly flags. */
export const questionCurationApproveInputSchema = z.object({
  items: z.array(questionCurationApproveItemSchema).min(1).max(QUESTION_CURATION_APPROVAL_MAX)
    .refine(value => unique(value.map(item => item.id)), 'duplicate_ids'),
  idempotencyKey: idSchema, reason: reasonSchema,
}).strict();
export type QuestionCurationApproveInput = z.infer<typeof questionCurationApproveInputSchema>;
export const questionCurationApproveOutcomes = ['published', 'already_published', 'blocked', 'conflict', 'not_found', 'not_eligible'] as const;
export const questionCurationApproveItemResultSchema = z.object({
  id: idSchema, outcome: z.enum(questionCurationApproveOutcomes),
  version: z.number().int().positive().nullable(), contentHash: questionCurationHashSchema.nullable(),
  curationScopeHash: questionCurationHashSchema.nullable(), sourceRevisionId: idSchema.nullable(),
  blockers: z.array(z.enum(questionCurationBlockerCodes)).max(questionCurationBlockerCodes.length).refine(unique, 'duplicate_blockers'),
}).strict().superRefine((value, ctx) => {
  if (['published', 'already_published'].includes(value.outcome) &&
      (value.version === null || !value.contentHash || !value.curationScopeHash || !value.sourceRevisionId || value.blockers.length))
    ctx.addIssue({ code: 'custom', message: 'published_requires_signed_scope' });
  if (value.outcome === 'blocked' && !value.blockers.length)
    ctx.addIssue({ code: 'custom', path: ['blockers'], message: 'blocked_requires_reason' });
});
export const questionCurationApproveDataSchema = z.object({
  replayed: z.boolean(), results: z.array(questionCurationApproveItemResultSchema).min(1).max(QUESTION_CURATION_APPROVAL_MAX)
    .refine(value => unique(value.map(item => item.id)), 'duplicate_result_ids'),
}).strict();
export const questionCurationApproveResultSchema = questionCurationApproveDataSchema.extend({ audit: auditEntrySchema }).strict();
export type QuestionCurationApproveResult = z.infer<typeof questionCurationApproveResultSchema>;
