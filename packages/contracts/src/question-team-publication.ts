/** G29-P: an explicit team declaration for the frozen official-exam corpus; never a license or medical review. */
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { reasonSchema } from './admin';
import { healthProfessionCodeSchema } from './health-taxonomy';
export const QUESTION_TEAM_NAMESPACE = 'g29-cp21-20261019' as const;
export const QUESTION_TEAM_CORPUS_HASH = '0616493c0f337e4edb1a8f698cacd40dbe1466933eeba5256a65cf073d9c8d2e' as const;
export const QUESTION_TEAM_MANIFEST_HASH = 'f3d40e71a86c071b2792e49bb09e1f3030b9aaf3ca66e94a94cba1055a0afc63' as const;
/** SHA256 of sorted offlineId + TAB + payloadSha256 + LF, UTF-8, C/byte ordering. */
export const QUESTION_TEAM_MEMBERSHIP_HASH = 'a6e42dd838112d7c3e74de2b58f9a6f65644b7242c5494553de4756abeba2ba8' as const;
export const QUESTION_TEAM_EXPECTED_COUNT = 28188 as const;
export const QUESTION_TEAM_ATTESTATION = 'Publique todas. Todas foram validadas pelo time da Remoa.' as const;
export const questionTeamFlags = ['annulled', 'key_conflict', 'image_missing', 'key_finality_unverified'] as const;
export const questionTeamFlagSchema = z.enum(questionTeamFlags);
/** Frozen source metadata tags, not ENAMED bindings or editorial classification. Labels belong to @remoa/strings. */
export const questionSourceAreaCodes = [
  'clinica-medica', 'cirurgia', 'pediatria', 'ginecologia-obstetricia', 'medicina-familia-comunidade', 'saude-publica',
  'formacao-geral', 'clinica-e-cirurgia', 'producao-animal', 'reproducao', 'inspecao-e-tecnologia',
  'deontologia-legislacao-bem-estar', 'microbiologia-imunologia-infecciosas', 'patologia',
] as const;
export const questionSourceAreaCodeSchema = z.enum(questionSourceAreaCodes);
export type QuestionSourceAreaCode = z.infer<typeof questionSourceAreaCodeSchema>;
export const questionTeamDisclosureSchema = z.object({
  kind: z.literal('remoa_team_attested'), rightsStatus: z.literal('pending'),
  medicalReview: z.literal(false), explanationStatus: z.enum(['absent', 'source_provided']),
  professionCode: healthProfessionCodeSchema,
  /** D-1885 / CCR-172: the source's current administrative approval is distinct from immutable question rights.
   * Remoa's own attestation never asserts that a third-party licensing document was verified. */
  sourceRightsStatus: z.enum(['pending', 'authorized', 'restricted', 'revoked']).optional(),
  sourceApprovalBasis: z.enum(['unverified', 'remoa_admin_attestation']).optional(),
  sourceRightsExpiresAt: timestampSchema.nullable().optional(),
  /** Optional only for historical snapshots; current producers always emit an explicit array and status.
   * These source tags remain unreviewed. They must not populate areaId/topicId or assert ENAMED confirmation. */
  sourceAreaCodes: z.array(questionSourceAreaCodeSchema).max(14).refine(v => new Set(v).size === v.length, 'duplicate_source_areas').optional(),
  classificationStatus: z.enum(['unclassified', 'source_tags_unreviewed']).optional(),
  flags: z.array(questionTeamFlagSchema).max(4).refine(v => new Set(v).size === v.length, 'duplicate_flags'),
  resolutionEligible: z.boolean(), declarationDate: z.literal('2026-10-19'),
}).strict().refine(v => !v.resolutionEligible || !v.flags.some(f => ['annulled', 'key_conflict', 'image_missing'].includes(f)), 'unresolved_not_eligible').refine(v =>
  (v.sourceAreaCodes === undefined && v.classificationStatus === undefined) ||
  (v.sourceAreaCodes !== undefined && v.classificationStatus === (v.sourceAreaCodes.length ? 'source_tags_unreviewed' : 'unclassified')),
  'source_classification_status_mismatch').refine(v =>
  (v.sourceRightsStatus === undefined && v.sourceApprovalBasis === undefined && v.sourceRightsExpiresAt === undefined) ||
  (v.sourceRightsStatus !== undefined && v.sourceApprovalBasis !== undefined && v.sourceRightsExpiresAt !== undefined &&
   (v.sourceRightsStatus !== 'authorized' || (v.sourceApprovalBasis === 'remoa_admin_attestation' && v.sourceRightsExpiresAt !== null))),
  'source_approval_disclosure_mismatch');
export type QuestionTeamDisclosure = z.infer<typeof questionTeamDisclosureSchema>;
const operation = z.object({ idempotencyKey: idSchema, reason: reasonSchema }).strict();
export const questionTeamCreateInputSchema = operation;
export const questionTeamActivateInputSchema = operation;
export const questionTeamItemsInputSchema = operation.extend({ batchIndex: z.number().int().min(1).max(141), rawJsonl: z.string().min(1).max(8 * 1024 * 1024) }).strict();
export const questionTeamAssetsInputSchema = operation.extend({ files: z.array(z.object({ path: z.string().min(1).max(2000), base64: z.string().min(4).max(70 * 1024 * 1024) }).strict()).min(1).max(20) }).strict();
export type QuestionTeamItemsInput = z.infer<typeof questionTeamItemsInputSchema>;
export type QuestionTeamAssetsInput = z.infer<typeof questionTeamAssetsInputSchema>;
