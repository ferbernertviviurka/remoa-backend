/** F33 / CCR-100–109. Catalog DTOs are separate from the F32 A–D generator. */
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { auditEntrySchema, reasonSchema } from './admin';
import { catalogAlternativeKeys } from './constants';
export {
  QUESTION_PDF_PARSER_VERSION, QUESTION_PDF_OCR_MODEL_ID, QUESTION_PDF_OCR_MODEL_COMMIT,
  QUESTION_PDF_OCR_MODEL_SHA256, QUESTION_PDF_OCR_DPI, QUESTION_PDF_OCR_VERSION, catalogAlternativeKeys,
} from './constants';
const httpUrl = z.string().url().refine((url) => /^https?:\/\//i.test(url), 'http_url_required');
export const questionOrigins = ['official_exam', 'remoa_authored', 'ai_generated', 'user_authored'] as const;
export const questionVisibilities = ['private', 'public'] as const;
export const questionCatalogStatuses = ['draft', 'in_review', 'approved', 'published', 'withdrawn', 'rejected'] as const;
export const questionRightsStatuses = ['pending', 'authorized', 'restricted', 'revoked'] as const;
export const questionAvailabilityStatuses = ['active', 'annulled', 'superseded', 'unavailable'] as const;
export const questionImportStatuses = ['queued', 'validating', 'extracting', 'ocr', 'segmenting', 'matching', 'review', 'completed', 'failed', 'cancelled', 'budget_paused'] as const;
export const questionCandidateStatuses = ['pending', 'needs_review', 'accepted', 'rejected', 'duplicate'] as const;
export type QuestionOrigin = typeof questionOrigins[number];
export type QuestionVisibility = typeof questionVisibilities[number];
export const catalogAlternativeSchema = z.object({ key: z.enum(catalogAlternativeKeys), text: z.string().min(1).max(6000) }).strict();
export const catalogAlternativesSchema = z.array(catalogAlternativeSchema).min(2).max(10).refine((a) => new Set(a.map((x) => x.key)).size === a.length, 'duplicate_keys');
export const questionProvenanceSchema = z.object({ documentId: idSchema, page: z.number().int().positive(), bbox: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).nullable() }).strict();
export type QuestionProvenance = z.infer<typeof questionProvenanceSchema>;
export const questionAssetSchema = z.object({ id: idSchema, alt: z.string().max(2000), url: httpUrl, provenance: questionProvenanceSchema.nullable() }).strict();
export const questionListQuerySchema = z.object({ scope: z.enum(['catalog', 'mine', 'all']).default('all'), search: z.string().max(200).optional(), origin: z.enum(questionOrigins).optional(), boardId: idSchema.optional(), type: z.enum(['objective', 'discursive']).optional(), topicId: idSchema.optional(), areaId: idSchema.optional(), sourceId: idSchema.optional(), examId: idSchema.optional(), institution: z.string().trim().min(1).max(300).optional(), year: z.coerce.number().int().min(1900).max(2200).optional(), difficulty: z.enum(['easy', 'medium', 'hard']).optional(), state: z.enum(['unseen', 'answered', 'wrong', 'favorite', 'doubtful']).optional(), cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(50).default(25) }).strict();
export type QuestionListQuery = z.infer<typeof questionListQuerySchema>;
export const questionUserStateSchema = z.object({ favorite: z.boolean(), doubtful: z.boolean(), annotation: z.string().max(10000) }).strict();
export type QuestionUserState = z.infer<typeof questionUserStateSchema>;
/** CCR122: bounded authorized booklet provenance, without answer keys. */
export const questionOccurrencePublicSchema=z.object({examId:idSchema,name:z.string().max(300),institution:z.string().max(300),year:z.number().int(),edition:z.string().max(200),booklet:z.string().max(100),ordinal:z.number().int().nonnegative(),originalNumber:z.string().max(100),sourceId:idSchema,sourceLabel:z.string().max(300)}).strict();
export const questionOccurrencesSchema=z.object({items:z.array(questionOccurrencePublicSchema).max(10),total:z.number().int().nonnegative(),truncated:z.boolean()}).strict().refine(x=>x.total>=x.items.length && x.truncated===(x.total>x.items.length),'occurrence_count_mismatch');
export type QuestionOccurrences=z.infer<typeof questionOccurrencesSchema>;
export const questionPublicSchema = z.object({ id: idSchema, canonicalId: idSchema, version: z.number().int().positive(), type: z.enum(['objective', 'discursive']), stem: z.string().min(1).max(20000), alternatives: catalogAlternativesSchema.nullable(), origin: z.enum(questionOrigins), visibility: z.enum(questionVisibilities), availability: z.enum(questionAvailabilityStatuses), difficulty: z.enum(['easy', 'medium', 'hard']), topicId: idSchema.nullable(), areaId: idSchema.nullable(), sourceId: idSchema.nullable(), sourceLabel: z.string().max(300).nullable(), occurrences:questionOccurrencesSchema.optional(), reviewed: z.boolean(), assets: z.array(questionAssetSchema), boardId: idSchema.nullable().default(null), boardTitle: z.string().max(300).nullable().optional(), userState: questionUserStateSchema.optional(), cardIds: z.array(idSchema), createdAt: timestampSchema }).strict();
export type QuestionPublic = z.infer<typeof questionPublicSchema>;
export const questionListResultSchema = z.object({ items: z.array(questionPublicSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() }).strict();
/** Never use this schema on catalog, session creation, or answer acknowledgement. Gate reference on server. */
export const questionReferenceAfterAnswerSchema = z.object({ questionId: idSchema, version: z.number().int().positive(), correctKey: z.enum(catalogAlternativeKeys).nullable(), explanation: z.string().max(20000).nullable(), distractorNotes: z.record(z.enum(catalogAlternativeKeys), z.string().max(6000)).nullable(), annulled: z.boolean(), reviewed: z.boolean(), reviewerName: z.string().nullable(), reviewerCrm: z.string().nullable(), referenceDate: z.string().nullable(), sourceUrl: httpUrl.nullable(), obsolete: z.boolean() }).strict();
export type QuestionReferenceAfterAnswer = z.infer<typeof questionReferenceAfterAnswerSchema>;
export const examPaperPublicSchema = z.object({ id: idSchema, name: z.string().min(1).max(300), institution: z.string().min(1).max(300), year: z.number().int(), edition: z.string().max(200), booklet: z.string().max(100), sourceId: idSchema, version: z.number().int().positive(), durationSec: z.number().int().positive().nullable(), questionCount: z.number().int().nonnegative(), status: z.enum(['draft', 'published', 'withdrawn']) }).strict();
export type ExamPaperPublic = z.infer<typeof examPaperPublicSchema>;
export const questionSessionConfigSchema = z.object({ mode: z.enum(['study', 'simulation']), examId: idSchema.optional(), questionIds: z.array(idSchema).min(1).max(200).optional(), filters: questionListQuerySchema.optional(), count: z.number().int().min(1).max(200), timerSec: z.number().int().min(60).max(86400).nullable().default(null), shuffle: z.boolean().default(false) }).strict().refine((x) => Number(x.examId !== undefined) + Number(x.questionIds !== undefined) + Number(x.filters !== undefined) === 1, 'one_selection_required');
export type QuestionSessionConfig = z.infer<typeof questionSessionConfigSchema>;
export const questionSessionItemPublicSchema = z.object({ id: idSchema, position: z.number().int().nonnegative(), question: questionPublicSchema, originalNumber: z.string().nullable(), selectedKey: z.enum(catalogAlternativeKeys).nullable(), answered: z.boolean(), doubtful: z.boolean(), revision: z.number().int().nonnegative() }).strict();
export const questionSessionPublicSchema = z.object({ id: idSchema, mode: z.enum(['study', 'simulation']), status: z.enum(['active', 'finished', 'expired']), revision: z.number().int().nonnegative(), startedAt: timestampSchema, deadline: timestampSchema.nullable(), finishedAt: timestampSchema.nullable(), serverTime: timestampSchema, items: z.array(questionSessionItemPublicSchema) }).strict();
export type QuestionSessionPublic = z.infer<typeof questionSessionPublicSchema>;
export const questionAnswerInputSchema = z.object({ selectedKey: z.enum(catalogAlternativeKeys).nullable(), mutationId: idSchema, revision: z.number().int().nonnegative(), elapsedMs: z.number().int().min(0).max(86400000) }).strict();
export type QuestionAnswerInput = z.infer<typeof questionAnswerInputSchema>;
export const questionAnswerSavedSchema = z.object({ itemId: idSchema, selectedKey: z.enum(catalogAlternativeKeys).nullable(), revision: z.number().int().nonnegative(), savedAt: timestampSchema }).strict();
export const questionSessionReportSchema = z.object({ sessionId: idSchema, version: z.number().int().positive(), correct: z.number().int().nonnegative(), incorrect: z.number().int().nonnegative(), unanswered: z.number().int().nonnegative(), annulled: z.number().int().nonnegative(), denominator: z.number().int().nonnegative(), score: z.number().min(0).max(1).nullable(), items: z.array(z.object({ itemId: idSchema, result: z.enum(['correct', 'incorrect', 'unanswered', 'annulled']), reference: questionReferenceAfterAnswerSchema }).strict()) }).strict();
export type QuestionSessionReport = z.infer<typeof questionSessionReportSchema>;
export const questionUserStateInputSchema = z.object({ favorite: z.boolean().optional(), doubtful: z.boolean().optional(), annotation: z.string().max(10000).optional() }).strict();
export const examPaperDetailSchema = z.object({ paper: examPaperPublicSchema, questions: z.array(questionPublicSchema) }).strict();
export const questionSessionSummaryPublicSchema=questionSessionPublicSchema.omit({items:true}).extend({count:z.number().int().nonnegative(),answeredCount:z.number().int().nonnegative()}).strict();
export type QuestionSessionSummaryPublic=z.infer<typeof questionSessionSummaryPublicSchema>;
export const questionSessionsListSchema = z.array(questionSessionSummaryPublicSchema).max(20);
export const questionReportInputSchema = z.object({ version: z.number().int().positive(), type: z.enum(['key', 'statement', 'image', 'explanation', 'rights', 'other']), description: z.string().min(8).max(3000) }).strict();
const adminReason = z.string().trim().min(8).max(500);
export const questionSourceInputSchema = z.object({ name: z.string().min(1).max(300), publisher: z.string().min(1).max(300), url: httpUrl, rightsStatus: z.enum(questionRightsStatuses).default('pending'), rightsEvidence: z.string().max(4000).nullable().default(null), rightsScope: z.string().max(2000).nullable().default(null), rightsExpiresAt: timestampSchema.nullable().default(null), reason: adminReason }).strict().refine((x) => x.rightsStatus !== 'authorized' || Boolean(x.rightsEvidence?.trim()), 'rights_evidence_required');
/** CCR133 original answer-key page numbers; null keeps the legacy whole-document scope. */
export const questionAnswerKeyPagesSchema = z.array(z.number().int().min(1).max(500)).min(1).max(500)
  .refine(pages => new Set(pages).size === pages.length, 'duplicate_answer_key_pages')
  .transform(pages => [...pages].sort((a,b) => a-b)).nullable().default(null);
export const questionImportInputSchema = z.object({ sourceId: idSchema, exam: examPaperPublicSchema.omit({ id: true, sourceId: true, version: true, questionCount: true, status: true }), documentId: idSchema, answerKeyDocumentId: idSchema.nullable(), answerKeyPages: questionAnswerKeyPagesSchema, parserVersion: z.string().min(1).max(100), ocr: z.boolean().default(true), excludedPages: z.array(z.number().int().min(1).max(500)).max(500).refine((pages) => new Set(pages).size === pages.length, 'duplicate_pages').default([]), budgetCents: z.number().int().nonnegative().max(100000), reason: adminReason }).strict().refine(input => input.answerKeyPages === null || input.answerKeyDocumentId !== null, { message:'answer_key_document_required',path:['answerKeyPages'] });
export type QuestionImportInput = z.infer<typeof questionImportInputSchema>;
export const questionImportProgressSchema = z.object({ id: idSchema, answerKeyPages: questionAnswerKeyPagesSchema, revision:z.number().int().nonnegative().default(0), status: z.enum(questionImportStatuses), totalPages: z.number().int().nonnegative(), completedPages: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(), accepted: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), duplicate: z.number().int().nonnegative(), costCents: z.number().int().nonnegative(), errorCode: z.string().nullable(), updatedAt: timestampSchema }).strict();
export type QuestionImportProgress = z.infer<typeof questionImportProgressSchema>;
export const importCandidateReviewInputSchema = z.object({ ownStem:z.string().min(1).max(20000).optional(), stem: z.string().min(1).max(20000), alternatives: catalogAlternativesSchema.nullable(), correctKey: z.enum(catalogAlternativeKeys).nullable(), explanation: z.string().max(20000).nullable(), topicId: idSchema.nullable(), areaId: idSchema.nullable(), annulled: z.boolean(), keyFinal: z.boolean(), integrityConfirmed: z.boolean(), imagesConfirmed: z.boolean().default(false), assets: z.array(z.object({ id: idSchema, objectKey: z.string().min(1).max(2000), alt: z.string().min(1).max(2000), provenance: questionProvenanceSchema }).strict()).max(10).optional(), state: z.enum(questionCandidateStatuses), duplicateOf: idSchema.nullable(), revision: z.number().int().nonnegative(), importRevision:z.number().int().nonnegative().default(0), reason: adminReason }).strict()
  .refine((x)=>x.correctKey===null||!x.alternatives||x.alternatives.some(a=>a.key===x.correctKey),'key_not_in_alternatives')
  .refine((x)=>!['accepted','duplicate'].includes(x.state)||(x.keyFinal&&(x.annulled||x.correctKey!==null)),'final_key_required');
export type ImportCandidateReviewInput = z.infer<typeof importCandidateReviewInputSchema>;
export const questionPublishInputSchema = z.object({ expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), reason: adminReason }).strict();
export type QuestionPublishInput = z.infer<typeof questionPublishInputSchema>;
export const questionEditorialReviewInputSchema = z.object({ decision: z.enum(['approved', 'changes_requested', 'rejected']), contentHash: z.string().regex(/^[a-f0-9]{64}$/), referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const d=new Date(value+'T00:00:00Z');return Number(value.slice(0,4))>0 && !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10)===value;},'invalid_calendar_date'), reason: adminReason }).strict();
/** SERVER ONLY: durable provider receipt; client cannot supply producer metadata. */
export const questionGenerationEnvelopeSchema = z.object({ executionId: idSchema, ownerId: idSchema, producer: z.string().min(1).max(100), model: z.string().min(1).max(200), provider: z.string().min(1).max(100), promptId: z.string().max(200), promptVersion: z.string().max(100), boardId: idSchema.nullable(), boardVersion: z.number().int().nullable(), requestKey: z.string().min(1).max(300), receivedAt: timestampSchema, candidates: z.array(z.unknown()).max(1000) }).strict();
export type QuestionGenerationEnvelope = z.infer<typeof questionGenerationEnvelopeSchema>;

/** F33 admin/reviewer responses. These privileged DTOs never appear in the student catalog. */
export const questionSourceSchema = z.object({
  id:idSchema,name:z.string(),publisher:z.string(),url:httpUrl,rightsStatus:z.enum(questionRightsStatuses),rightsEvidence:z.string().nullable(),rightsScope:z.string().nullable(),rightsExpiresAt:timestampSchema.nullable(),accessedAt:timestampSchema,documentVersion:z.string().nullable(),createdAt:timestampSchema,updatedAt:timestampSchema,
}).strict();
export type QuestionSource = z.infer<typeof questionSourceSchema>;
export const questionDocumentSchema = z.object({id:idSchema,kind:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive(),pages:z.number().int().positive().nullable()}).strict();
export type QuestionDocument = z.infer<typeof questionDocumentSchema>;
export const questionStoredAssetSchema = z.object({id:idSchema,objectKey:z.string().min(1).max(2000),alt:z.string().max(2000),provenance:questionProvenanceSchema,url:httpUrl.nullable().optional()}).strict();
const parserBoxSchema=z.object({x:z.number(),y:z.number(),width:z.number().nonnegative(),height:z.number().nonnegative()}).strict();
const parserProvenanceSchema=z.object({page:z.number().int().positive(),bbox:parserBoxSchema,method:z.enum(['text','ocr','manual_page'])}).strict();
export const questionCandidateImageRefSchema=parserProvenanceSchema.extend({objectKey:z.string().min(1),provenance:questionProvenanceSchema.optional(),url:httpUrl.optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),bytes:z.number().int().positive().optional()}).strict();
export const questionCandidatePageImageInputSchema=z.object({page:z.number().int().min(1).max(500),revision:z.number().int().nonnegative(),importRevision:z.number().int().nonnegative().default(0),reason:reasonSchema}).strict();
export type QuestionCandidatePageImageInput=z.infer<typeof questionCandidatePageImageInputSchema>;
/** Staging must retain malformed/duplicate alternatives for correction. Acceptance uses the stricter input schema. */
/** CCR130: all editor mutations lock import → paper → contexts(id) → candidates(id) → questions(id).
 * Unknown-scope unresolved contexts block acceptance for the entire import. Evidence is immutable.
 */
export const questionOriginalNumberSchema = z.string().regex(/^\d{1,3}$/).refine(v => Number(v) >= 1 && Number(v) <= 999, 'original_number_out_of_range').transform(v => String(Number(v)));
const importRevisionSchema=z.number().int().nonnegative();
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const numbersSchema=z.array(z.number().int().min(1).max(999)).max(999).refine(v=>new Set(v).size===v.length,'duplicate_numbers');
const idsSchema=z.array(idSchema).max(10).refine(v=>new Set(v).size===v.length,'duplicate_image_refs');
export const questionContextBindingSchema=z.object({contextId:idSchema,contextRevision:importRevisionSchema,resolutionHash:hashSchema}).strict();
export const questionContextImageRefSchema=questionCandidateImageRefSchema.extend({id:idSchema}).strict();
const contextResolutionFields={decision:z.enum(['bind','non_question']),targetNumbers:numbersSchema,text:z.string().max(20000),imageRefIds:idsSchema,reason:reasonSchema};
const validateContextResolution=(v:{decision:string;targetNumbers:number[];text:string;imageRefIds:string[]},ctx:z.RefinementCtx)=>{
  if(v.decision==='bind' && (!v.targetNumbers.length || (!v.text.trim() && !v.imageRefIds.length)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'context_targets_and_content_required'});
  if(v.decision==='non_question' && (v.targetNumbers.length || v.text || v.imageRefIds.length))ctx.addIssue({code:z.ZodIssueCode.custom,message:'non_question_has_bindings'});
};
export const questionImportContextResolutionSchema=z.object(contextResolutionFields).strict().superRefine(validateContextResolution);
export const questionImportContextSchema=z.object({
  id:idSchema,importId:idSchema,documentId:idSchema,evidenceHash:hashSchema,
  evidenceObjectKey:z.string().regex(/^questions\/imports\/[^/]+\/contexts\/.+/),
  originalText:z.string().max(100000).nullable(),declaredNumbers:numbersSchema,
  provenance:z.array(questionProvenanceSchema).min(1).max(500),imageRefs:z.array(questionContextImageRefSchema).max(100),
  revision:importRevisionSchema,status:z.enum(['unresolved','bound','non_question']),
  resolution:questionImportContextResolutionSchema.nullable(),resolutionHash:hashSchema.nullable(),
  createdAt:timestampSchema,updatedAt:timestampSchema,
}).strict().superRefine((v,ctx)=>{
  if(!v.evidenceObjectKey.startsWith(`questions/imports/${v.importId}/contexts/`))ctx.addIssue({code:z.ZodIssueCode.custom,message:'context_evidence_import_mismatch'});
  if(v.provenance.some(ref=>ref.documentId!==v.documentId))ctx.addIssue({code:z.ZodIssueCode.custom,message:'context_document_mismatch'});
  if(v.resolution?.imageRefIds.some(id=>!v.imageRefs.some(ref=>ref.id===id)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'context_image_ref_unknown'});
  if(v.status!=='unresolved' && (!v.resolution || !v.resolutionHash))ctx.addIssue({code:z.ZodIssueCode.custom,message:'bound_resolution_required'});
  if(v.resolution && ((v.status==='bound' && v.resolution.decision!=='bind') || (v.status==='non_question' && v.resolution.decision!=='non_question')))ctx.addIssue({code:z.ZodIssueCode.custom,message:'context_resolution_status_mismatch'});
  if(v.status==='unresolved' && (v.resolution || v.resolutionHash))ctx.addIssue({code:z.ZodIssueCode.custom,message:'unresolved_has_resolution'});
});
export type QuestionImportContext=z.infer<typeof questionImportContextSchema>;
/** Manual marker evidence is a real positive normalized region, never a guessed glyph. */
export const manualMarkerSchema=questionProvenanceSchema.extend({page:z.number().int().min(1).max(500),bbox:z.tuple([z.number().finite().min(0).max(1),z.number().finite().min(0).max(1),z.number().finite().positive().max(1),z.number().finite().positive().max(1)])}).strict().refine(v=>v.bbox[0]+v.bbox[2]<=1 && v.bbox[1]+v.bbox[3]<=1,'marker_outside_page');
export const questionManualRecoverySchema=z.object({requestHash:hashSchema,markerProvenance:manualMarkerSchema}).strict();
export const questionCandidateCreateInputSchema=z.object({candidateId:idSchema,importRevision:importRevisionSchema,originalNumber:questionOriginalNumberSchema,markerProvenance:manualMarkerSchema,ownStem:z.string().min(1).max(20000),alternatives:z.array(z.object({key:z.string().max(10),text:z.string().max(20000)}).strict()).max(100).nullable(),provenance:z.array(questionProvenanceSchema).min(1).max(500),reason:reasonSchema}).strict();
export type QuestionCandidateCreateInput=z.infer<typeof questionCandidateCreateInputSchema>;
export const questionCandidateNumberInputSchema=z.object({importRevision:importRevisionSchema,revision:importRevisionSchema,originalNumber:questionOriginalNumberSchema,markerProvenance:manualMarkerSchema,reason:reasonSchema}).strict();
export type QuestionCandidateNumberInput=z.infer<typeof questionCandidateNumberInputSchema>;
export const questionImportContextResolveInputSchema=z.object({...contextResolutionFields,importRevision:importRevisionSchema,revision:importRevisionSchema,evidenceHash:hashSchema}).strict().superRefine(validateContextResolution);
export type QuestionImportContextResolveInput=z.infer<typeof questionImportContextResolveInputSchema>;
export const questionCandidatePayloadSchema=z.object({
  parserMarkerEvidence:z.object({originalNumber:z.number().int().min(1).max(999),provenance:parserProvenanceSchema}).strict().optional(),
  numberRecovery:z.object({originalNumber:questionOriginalNumberSchema,markerProvenance:manualMarkerSchema,revision:importRevisionSchema,reason:reasonSchema}).strict().optional(),ownProvenance:z.array(questionProvenanceSchema).max(500).optional(),ownImageRefs:z.array(questionCandidateImageRefSchema).max(100).optional(),manualRecovery:questionManualRecoverySchema.optional(),ownStem:z.string().max(20000).optional(),contextBindings:z.array(questionContextBindingSchema).max(100).default([]),originalNumber:z.number().int().optional(),stem:z.string(),alternatives:z.array(z.object({key:z.string(),text:z.string()}).strict()).max(100).nullable(),correctKey:z.string().nullable(),annulled:z.boolean(),explanation:z.string().nullable().default(null),areaId:idSchema.nullable().default(null),topicId:idSchema.nullable().default(null),keyFinal:z.boolean().default(false),integrityConfirmed:z.boolean().default(false),imagesConfirmed:z.boolean().default(false),assets:z.array(questionStoredAssetSchema).default([]),imageRefs:z.array(questionCandidateImageRefSchema).default([]),provenance:z.array(parserProvenanceSchema).optional(),confidence:z.record(z.number()).optional(),issues:z.array(z.string()).optional(),status:z.literal('staging').optional(),state:z.enum(questionCandidateStatuses).optional(),duplicateOf:idSchema.nullable().optional(),revision:z.number().int().optional(),reason:z.string().optional(),privateImageRefs:z.array(questionCandidateImageRefSchema).optional(),
}).strict();
export const questionCandidateSchema=z.object({id:idSchema,importId:idSchema,chunkId:idSchema.nullable(),ordinal:z.number().int(),originalNumber:z.string().nullable(),payload:questionCandidatePayloadSchema,confidence:z.record(z.number()),provenance:z.array(questionProvenanceSchema),issues:z.array(z.string()),fingerprint:z.string().nullable(),duplicateOf:idSchema.nullable(),questionId:idSchema.nullable(),state:z.enum(questionCandidateStatuses),revision:z.number().int().nonnegative(),createdAt:timestampSchema,updatedAt:timestampSchema}).strict();
export type QuestionCandidate = z.infer<typeof questionCandidateSchema>;
export const questionExamPaperAdminSchema=examPaperPublicSchema.omit({questionCount:true}).extend({documentId:idSchema.nullable(),answerKeyDocumentId:idSchema.nullable(),keyFinal:z.boolean(),keyRevision:z.string().nullable(),createdAt:timestampSchema,updatedAt:timestampSchema}).strict();
export const questionReviewDetailSchema=z.object({contextManaged:z.boolean().default(false),ownStem:z.string().max(20000).nullable().default(null),contextBindings:z.array(questionContextBindingSchema).max(100).default([]),id:idSchema,canonicalId:idSchema,version:z.number().int().positive(),type:z.enum(['objective','discursive']),difficulty:z.enum(['easy','medium','hard']),stem:z.string(),alternatives:catalogAlternativesSchema.nullable(),correctKey:z.enum(catalogAlternativeKeys).nullable(),explanation:z.string().nullable(),areaId:idSchema.nullable(),topicId:idSchema.nullable(),origin:z.enum(questionOrigins),sourceId:idSchema.nullable(),catalogStatus:z.enum(questionCatalogStatuses),rightsStatus:z.enum(questionRightsStatuses),availability:z.enum(questionAvailabilityStatuses),integrityConfirmed:z.boolean(),keyFinal:z.boolean(),enamedConfirmed:z.boolean(),contentHash:z.string().nullable(),reviewedHash:z.string().nullable(),reviewerName:z.string().nullable(),reviewerCrm:z.string().nullable(),referenceDate:z.string().nullable(),assets:z.array(questionStoredAssetSchema)}).strict();
export type QuestionReviewDetail=z.infer<typeof questionReviewDetailSchema>;
export const questionLatestReviewSchema=z.object({decision:z.enum(['approved','changes_requested','rejected']),contentHash:z.string(),reviewerName:z.string(),reviewerCrm:z.string(),referenceDate:z.string(),reviewedAt:timestampSchema}).strict();
export const questionSourceListSchema=z.object({items:z.array(questionSourceSchema),audit:auditEntrySchema}).strict();
export const questionSourceResultSchema=z.object({source:questionSourceSchema,audit:auditEntrySchema}).strict();
export const questionDocumentUploadResultSchema=z.object({document:questionDocumentSchema,audit:auditEntrySchema}).strict();
export const questionDocumentPreviewSchema=z.object({id:idSchema,url:httpUrl,expiresInSec:z.number().int().positive(),audit:auditEntrySchema}).strict();
export const questionImportListSchema=z.object({items:z.array(questionImportProgressSchema),audit:auditEntrySchema}).strict();
export const questionImportCreatedSchema=z.object({import:questionImportProgressSchema,paperId:idSchema,audit:auditEntrySchema}).strict();
export const questionImportStatusResultSchema=z.object({import:questionImportProgressSchema,audit:auditEntrySchema}).strict();
export const questionImportDetailSchema=z.object({import:questionImportProgressSchema,paper:questionExamPaperAdminSchema.nullable(),candidates:z.array(questionCandidateSchema),contexts:z.array(questionImportContextSchema).max(1000).default([]),acceptanceBlocked:z.boolean().default(false),documents:z.array(questionDocumentSchema),audit:auditEntrySchema}).strict();
export const questionCandidateSavedSchema=z.object({candidate:questionCandidateSchema,questionId:idSchema.nullable(),importRevision:importRevisionSchema.default(0),affectedCandidates:z.array(questionCandidateSchema).default([]),audit:auditEntrySchema}).strict();
export const questionCandidatePageImageResultSchema=questionCandidateSavedSchema;
export const questionEditorialQueueSchema=z.object({items:z.array(questionReviewDetailSchema)}).strict();
export const questionEditorialDetailSchema=z.object({question:questionReviewDetailSchema,source:questionSourceSchema.nullable(),latestReview:questionLatestReviewSchema.nullable()}).strict();
export const questionMedicalReviewResultSchema=z.object({id:idSchema,decision:z.enum(['approved','changes_requested','rejected']),contentHash:z.string(),audit:auditEntrySchema}).strict();
export const questionPublicationResultSchema=z.object({id:idSchema,status:z.enum(['published','withdrawn']),audit:auditEntrySchema}).strict();
export const questionCatalogMetricsSchema=z.object({publicCanonical:z.number().int().nonnegative(),importsByStatus:z.array(z.object({status:z.enum(questionImportStatuses),count:z.number().int().nonnegative()}).strict()),candidateCounts:z.array(z.object({state:z.enum(questionCandidateStatuses),count:z.number().int().nonnegative()}).strict()),documents:z.number().int().nonnegative(),generatedPrivate:z.number().int().nonnegative(),duplicateOrVersionNotCounted:z.literal(true),publicByOrigin:z.array(z.object({origin:z.enum(questionOrigins),count:z.number().int().nonnegative()}).strict()).max(4).default([]),coverageByArea:z.array(z.object({areaId:idSchema,name:z.string(),count:z.number().int().nonnegative()}).strict()).max(500).default([]),coverageByTopic:z.array(z.object({topicId:idSchema,name:z.string(),count:z.number().int().nonnegative()}).strict()).max(500).default([]),coverageTruncated:z.boolean().default(false),audit:auditEntrySchema}).strict();
export const questionRectificationResultSchema=z.object({id:idSchema,version:z.number().int().positive(),supersedesId:idSchema,audit:auditEntrySchema}).strict();

export const questionDraftUpdateInputSchema=z.object({expectedContentHash:z.string().regex(/^[a-f0-9]{64}$/),content:importCandidateReviewInputSchema}).strict();
export const questionDraftSavedSchema=z.object({question:questionReviewDetailSchema,audit:auditEntrySchema}).strict();

/** Independent F33 rollout controls, authenticated endpoint. */
export const questionFeatureFlagsSchema=z.object({import:z.boolean(),catalog:z.boolean(),sessions:z.boolean()}).strict();
export type QuestionFeatureFlags=z.infer<typeof questionFeatureFlagsSchema>;

/** FR23: triage never exposes reporter identity or hidden references. */
export const questionReportQueueQuerySchema=z.object({status:z.enum(['open','resolved','dismissed']).optional(),type:questionReportInputSchema.shape.type.optional(),questionId:idSchema.optional(),limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().max(2000).optional()}).strict();
export type QuestionReportQueueQuery=z.infer<typeof questionReportQueueQuerySchema>;
export const questionReportQueueItemSchema=z.object({id:idSchema,questionId:idSchema,version:z.number().int().positive(),type:questionReportInputSchema.shape.type,description:z.string(),status:z.enum(['open','resolved','dismissed']),createdAt:timestampSchema,updatedAt:timestampSchema}).strict();
export const questionReportQueueSchema=z.object({items:z.array(questionReportQueueItemSchema),nextCursor:z.string().nullable(),audit:auditEntrySchema.optional()}).strict();
export const questionReportDetailSchema=z.object({report:questionReportQueueItemSchema,question:z.object({id:idSchema,version:z.number().int().positive(),canonicalId:idSchema,visibility:z.enum(questionVisibilities),catalogStatus:z.enum(questionCatalogStatuses),availability:z.enum(questionAvailabilityStatuses),stem:z.string().nullable()}).strict(),editable:z.boolean(),audit:auditEntrySchema.optional()}).strict();
export const questionReportResolveInputSchema=z.object({status:z.enum(['open','resolved','dismissed']),reason:reasonSchema,expectedUpdatedAt:timestampSchema}).strict();
export type QuestionReportResolveInput=z.infer<typeof questionReportResolveInputSchema>;
export const questionReportResolveResultSchema=z.object({report:questionReportQueueItemSchema,changed:z.boolean(),audit:auditEntrySchema}).strict();

/** CCR117: bounded options, published authorized papers only. */
export const questionInstitutionListSchema=z.object({items:z.array(z.object({name:z.string().min(1).max(300),paperCount:z.number().int().positive()}).strict()).max(500),truncated:z.boolean()}).strict();
export type QuestionInstitutionList=z.infer<typeof questionInstitutionListSchema>;
/** CCR116: an optional comparison never changes the frozen original report. */
export const questionRecalculationReasonCodes=['version_changed','key_changed','annulled','rights_unavailable','content_not_comparable','unchanged'] as const;
export const questionSessionRecalculationItemSchema=z.object({itemId:idSchema,originalQuestionId:idSchema,originalQuestionVersion:z.number().int().positive(),comparedQuestionId:idSchema.nullable(),comparedQuestionVersion:z.number().int().positive().nullable(),outcome:z.enum(['correct','incorrect','unanswered','annulled','unavailable','not_comparable']),reasonCode:z.enum(questionRecalculationReasonCodes),reference:questionReferenceAfterAnswerSchema.nullable()}).strict().refine(x=>!['unavailable','not_comparable'].includes(x.outcome)||x.reference===null,'incomparable_reference_hidden');
export const questionSessionRecalculationSchema=z.object({sessionId:idSchema,originalVersion:z.number().int().positive(),calculatedAt:timestampSchema,complete:z.boolean(),aggregates:questionSessionReportSchema.omit({sessionId:true,version:true,items:true}).nullable(),items:z.array(questionSessionRecalculationItemSchema).max(200)}).strict().refine(x=>x.complete===!x.items.some(i=>['unavailable','not_comparable'].includes(i.outcome))&&(x.complete ? x.aggregates!==null : x.aggregates===null),'partial_score_forbidden');
export type QuestionSessionRecalculation=z.infer<typeof questionSessionRecalculationSchema>;

/** CCR130 recovery results expose every invalidated candidate and the new import revision. */
export const questionImportRecoveryResultSchema=z.object({candidate:questionCandidateSchema,affectedCandidates:z.array(questionCandidateSchema),importRevision:importRevisionSchema,audit:auditEntrySchema}).strict();
export const questionImportContextResolvedSchema=z.object({context:questionImportContextSchema,affectedCandidates:z.array(questionCandidateSchema),importRevision:importRevisionSchema,acceptanceBlocked:z.boolean(),audit:auditEntrySchema}).strict();
