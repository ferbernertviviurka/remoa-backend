/**
 * F33/G26 audited operations. Nothing here edits content, rights, review, integrity, answer key or taxonomy, or publishes.
 * D-1804/CCR146: content-hash preparation of institutional drafts whose content_hash is NULL (the PATCH CAS cannot match them).
 * D-1805/CCR144: bounded recovery of generation receipt/promotion outbox rows that reached the attempt limit.
 * D-1819: institutional approval + publication of Remoa-owned questions (the only operation here that publishes).
 */
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { auditEntrySchema, reasonSchema } from './admin';
import { QUESTION_REMOA_RIGHTS_SCOPE } from './question-catalog';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const uniqueBy = <T>(key: (item: T) => string) => (items: T[]) => new Set(items.map(key)).size === items.length;
const errorCode = z.string().regex(/^[a-z_]{3,100}$/);

// ── D-1804: content-hash preparation ──────────────────────────────────────────────────────────────────────────────
/** Canonical algorithm id of `contentHash()` (apps/api questions/imports/domain.ts); a change here is a new decision. */
export const QUESTION_CONTENT_HASH_VERSION = 'f33-content-v2-jsonb-assets' as const;
export const QUESTION_HASH_PREPARE_MAX = 500;
/**
 * POST /v1/admin/questions/content-hash/prepare (withAdmin 'question.content_hash_prepare', reauth, one audit row per call).
 * CAS per item: content_hash IS NULL, version = revision, updated_at (ms) = expectedUpdatedAt. Optional `sourceId` is linked
 * only where source_id IS NULL; the source's rights are never read as authorization nor changed.
 */
export const questionHashPrepareItemSchema = z.object({ id: idSchema, revision: z.number().int().positive(), expectedUpdatedAt: timestampSchema }).strict();
export const questionHashPrepareInputSchema = z.object({
  items: z.array(questionHashPrepareItemSchema).min(1).max(QUESTION_HASH_PREPARE_MAX).refine(uniqueBy(i => i.id), 'duplicate_ids'),
  sourceId: idSchema.nullable().default(null),
  idempotencyKey: idSchema,
  reason: reasonSchema,
}).strict();
export type QuestionHashPrepareInput = z.infer<typeof questionHashPrepareInputSchema>;
/**
 * prepared: hash written now (and source linked if asked). already_prepared: stored hash equals the canonical one, no write.
 * conflict: version/updated_at changed or stored hash differs. source_mismatch: row already has another source.
 * not_eligible: not institutional (user_id not null / private / origin outside official_exam|remoa_authored) or published.
 */
export const questionHashPrepareOutcomes = ['prepared', 'already_prepared', 'conflict', 'source_mismatch', 'not_eligible', 'not_found'] as const;
export const questionHashPrepareItemResultSchema = z.object({
  id: idSchema,
  outcome: z.enum(questionHashPrepareOutcomes),
  version: z.number().int().positive().nullable(),
  contentHash: hash.nullable(),
  sourceId: idSchema.nullable(),
}).strict();
export const questionHashPrepareResultSchema = z.object({
  hashVersion: z.literal(QUESTION_CONTENT_HASH_VERSION),
  /** Same admin + idempotencyKey + identical payload returns the stored results; nothing is rewritten. */
  replayed: z.boolean(),
  results: z.array(questionHashPrepareItemResultSchema).max(QUESTION_HASH_PREPARE_MAX),
  audit: auditEntrySchema,
}).strict();
export type QuestionHashPrepareResult = z.infer<typeof questionHashPrepareResultSchema>;

// ── D-1805 / CCR144: generation outbox recovery ───────────────────────────────────────────────────────────────────
export const QUESTION_OUTBOX_BASE_ATTEMPTS = 20;
/** Lifetime cap (DB check attempt_limit between 20 and 25). attempts and attempt_limit never decrease (trigger, 0052). */
export const QUESTION_OUTBOX_MAX_ATTEMPTS = 25;
/** Discovery (`question-promotion-discovery`) and map-link repair stay outside: they are not recoverable here. */
export const questionRecoveryTargets = ['question-receipt', 'question-promotion'] as const;
export const questionOutboxStates = ['pending', 'leased', 'exhausted', 'delivered'] as const;
const outboxLimit = z.coerce.number().int().min(1).max(50).default(25);
const outboxCursor = z.string().min(1).max(2048);

/** Metadata only: no payload reference/object key/URL, prompt, content, answer, CRM or private context. */
export const questionOutboxItemSchema = z.object({
  outboxId: idSchema,
  runId: idSchema,
  producer: z.string().min(1).max(100),
  target: z.enum(questionRecoveryTargets),
  state: z.enum(questionOutboxStates),
  attempts: count,
  attemptLimit: z.number().int().min(QUESTION_OUTBOX_BASE_ATTEMPTS).max(QUESTION_OUTBOX_MAX_ATTEMPTS),
  errorCode: errorCode.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deliveredAt: timestampSchema.nullable(),
}).strict();
export type QuestionOutboxItem = z.infer<typeof questionOutboxItemSchema>;

/** GET /v1/questions/generation/outbox — owner sees only own runs (withUser/RLS); read-only, no recovery. */
export const questionOwnerOutboxQuerySchema = z.object({ state: z.enum(questionOutboxStates).optional(), limit: outboxLimit, cursor: outboxCursor.optional() }).strict();
export const questionOwnerOutboxPageSchema = z.object({ items: z.array(questionOutboxItemSchema).max(50), nextCursor: outboxCursor.nullable() }).strict();

/** GET /v1/admin/questions/generation/outbox — withAdmin 'question.generation_view' (sensitive: false, auto reason). */
export const questionAdminOutboxQuerySchema = z.object({
  state: z.enum(questionOutboxStates).default('exhausted'),
  target: z.enum(questionRecoveryTargets).optional(),
  ownerId: idSchema.optional(),
  limit: outboxLimit,
  cursor: outboxCursor.optional(),
}).strict();
export const questionAdminOutboxItemSchema = questionOutboxItemSchema.extend({ ownerId: idSchema }).strict();
export const questionAdminOutboxPageSchema = z.object({ items: z.array(questionAdminOutboxItemSchema).max(50), nextCursor: outboxCursor.nullable(), audit: auditEntrySchema }).strict();

/**
 * POST /v1/admin/questions/generation/recover — withAdmin 'question.generation_recover', reauth, one audit row per call.
 * Per item, in one transaction: lock row, CAS (attempts, attempt_limit), require delivered_at IS NULL, lease expired, attempts >=
 * attempt_limit; validate the durable object (owner prefix, size, hash = run payload_hash, receipt/promotion metadata) without a
 * provider call, quota reservation or charge; then attempt_limit += min(extraAttempts, 25 - attempt_limit). attempts is untouched.
 */
export const questionOutboxRecoverInputSchema = z.object({
  items: z.array(z.object({ outboxId: idSchema, expectedAttempts: count, expectedAttemptLimit: z.number().int().min(QUESTION_OUTBOX_BASE_ATTEMPTS).max(QUESTION_OUTBOX_MAX_ATTEMPTS) }).strict())
    .min(1).max(50).refine(uniqueBy(i => i.outboxId), 'duplicate_ids'),
  extraAttempts: z.number().int().min(1).max(QUESTION_OUTBOX_MAX_ATTEMPTS - QUESTION_OUTBOX_BASE_ATTEMPTS),
  idempotencyKey: idSchema,
  reason: reasonSchema,
}).strict();
export type QuestionOutboxRecoverInput = z.infer<typeof questionOutboxRecoverInputSchema>;
export const questionOutboxRecoverOutcomes = ['granted', 'not_exhausted', 'limit_reached', 'leased', 'delivered', 'durable_content_missing', 'replay_metadata_invalid', 'conflict', 'not_found'] as const;
export const questionOutboxRecoverItemResultSchema = z.object({
  outboxId: idSchema,
  outcome: z.enum(questionOutboxRecoverOutcomes),
  granted: z.number().int().min(0).max(QUESTION_OUTBOX_MAX_ATTEMPTS - QUESTION_OUTBOX_BASE_ATTEMPTS),
  attempts: count.nullable(),
  attemptLimit: z.number().int().min(QUESTION_OUTBOX_BASE_ATTEMPTS).max(QUESTION_OUTBOX_MAX_ATTEMPTS).nullable(),
}).strict().refine(r => (r.outcome === 'granted') === (r.granted > 0), 'granted_mismatch');
export const questionOutboxRecoverResultSchema = z.object({ replayed: z.boolean(), results: z.array(questionOutboxRecoverItemResultSchema).max(50), audit: auditEntrySchema }).strict();
export type QuestionOutboxRecoverResult = z.infer<typeof questionOutboxRecoverResultSchema>;

/**
 * GET /v1/admin/questions/generation/metrics — withAdmin 'question.generation_view'. Aggregates only, local DB, never Mixpanel.
 * cost_cents = 0 does not prove a free call: those runs count as unknown, never as zero cost.
 */
export const questionGenerationMetricsQuerySchema = z.object({ windowHours: z.coerce.number().int().min(1).max(168).default(24) }).strict();
export const questionGenerationMetricsSchema = z.object({
  generatedAt: timestampSchema,
  windowHours: z.number().int().min(1).max(168),
  backlog: z.array(z.object({ target: z.enum(questionRecoveryTargets), pending: count, leased: count, exhausted: count, oldestPendingAt: timestampSchema.nullable() }).strict()).max(questionRecoveryTargets.length),
  /** recovered = delivered in the window with attempt_limit > 20 (needed an audited grant). */
  throughput: z.array(z.object({ target: z.enum(questionRecoveryTargets), delivered: count, recovered: count }).strict()).max(questionRecoveryTargets.length),
  cost: z.object({ runs: count, runsWithKnownCost: count, runsWithUnknownCost: count, knownCostCents: count }).strict()
    .refine(c => c.runs === c.runsWithKnownCost + c.runsWithUnknownCost, 'cost_runs_mismatch'),
  audit: auditEntrySchema,
}).strict();
export type QuestionGenerationMetrics = z.infer<typeof questionGenerationMetricsSchema>;

// ── D-1819: institutional approval (rule 6 exception, extends D-1522 to remoa_authored questions) ─────────────────
export const QUESTION_INSTITUTIONAL_APPROVE_MAX = 500;
/**
 * POST /v1/admin/questions/institutional-approval (withAdmin 'question.institutional_approve', reauth, ONE audit row per call:
 * target question_batch; after = idempotencyKey, requestHash, approverRole, approverName, rightsBasis, sourceId and per-item
 * {id, outcome, version, contentHash}; never stem/alternatives/explanation). Agents never call it on their own (CLAUDE.md rule 6).
 * Per item (own savepoint, lock order as publishQuestion), all must hold or the item is skipped with an outcome:
 *   user_id IS NULL, visibility public, origin remoa_authored, not withdrawn/rejected/superseded → else not_eligible
 *   catalog_status published → already_published · content_hash NULL → hash_missing (run D-1804 prepare first)
 *   version = revision and content_hash = expectedContentHash = recomputed contentHash() → else conflict
 *   type objective, availability active, correct_key among alternatives → else answer_key_missing (hard gate, no seal without a key)
 *   enamed_area_id + enamed_topic_id set and consistent → else taxonomy_missing · explanation non-empty → else explanation_missing
 *   source_id NULL or the Remoa-owned source → else source_mismatch
 * Effect: link the single Remoa-owned source (rights_scope 'remoa_owned', authorized, evidence from the attestation; created on
 * first use, never re-authorized if revoked → whole call fails conflict 'remoa_source_rights_revoked'); append a
 * question_editorial_reviews row kind 'remoa_institutional', decision approved, reviewer_name = approverName, reviewer_crm NULL,
 * content_hash = current hash, reference_date = approval date (America/Sao_Paulo); set status approved, rights_status authorized,
 * reviewed_hash = content_hash, reviewer_name, reviewer_crm NULL, reference_date, validation_kind 'remoa_institutional'
 * (integrity_confirmed/key_final/enamed_confirmed stay as they are: the seal is attestation, not confirmation); then the same
 * publication path as publishQuestion. Revocation: existing withdraw/rectify flow.
 */
export const questionInstitutionalApproveItemSchema = z.object({ id: idSchema, revision: z.number().int().positive(), expectedContentHash: hash }).strict();
export const questionInstitutionalAttestationSchema = z.object({
  approverRole: z.literal('medical_founder'),
  /** Display name only. Digits are refused so a CRM can never ride along. */
  approverName: z.string().trim().min(3).max(200).refine((n) => !/\d/.test(n), 'approver_name_without_crm'),
  rightsBasis: z.literal(QUESTION_REMOA_RIGHTS_SCOPE),
  /** Fernando's explicit acceptance (D-1819): key, integrity and taxonomy were not separately confirmed. */
  acceptsUnconfirmedChecks: z.literal(true),
}).strict();
export type QuestionInstitutionalAttestation = z.infer<typeof questionInstitutionalAttestationSchema>;
export const questionInstitutionalApproveInputSchema = z.object({
  items: z.array(questionInstitutionalApproveItemSchema).min(1).max(QUESTION_INSTITUTIONAL_APPROVE_MAX).refine(uniqueBy(i => i.id), 'duplicate_ids'),
  attestation: questionInstitutionalAttestationSchema,
  idempotencyKey: idSchema,
  reason: reasonSchema,
}).strict();
export type QuestionInstitutionalApproveInput = z.infer<typeof questionInstitutionalApproveInputSchema>;
export const questionInstitutionalApproveOutcomes = ['published', 'already_published', 'not_eligible', 'conflict', 'answer_key_missing', 'hash_missing', 'taxonomy_missing', 'explanation_missing', 'source_mismatch', 'not_found'] as const;
export type QuestionInstitutionalApproveOutcome = typeof questionInstitutionalApproveOutcomes[number];
export const questionInstitutionalApproveItemResultSchema = z.object({
  id: idSchema,
  outcome: z.enum(questionInstitutionalApproveOutcomes),
  version: z.number().int().positive().nullable(),
  contentHash: hash.nullable(),
}).strict();
export const questionInstitutionalApproveResultSchema = z.object({
  /** Same admin + idempotencyKey + identical payload (items sorted by id, attestation) returns stored results; nothing rewritten. */
  replayed: z.boolean(),
  sourceId: idSchema,
  results: z.array(questionInstitutionalApproveItemResultSchema).max(QUESTION_INSTITUTIONAL_APPROVE_MAX),
  audit: auditEntrySchema,
}).strict();
export type QuestionInstitutionalApproveResult = z.infer<typeof questionInstitutionalApproveResultSchema>;
