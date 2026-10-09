/** CCR139: bounded metadata discovery. Authorization and opaque cursor signing are server responsibilities. */
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { auditEntrySchema, reasonSchema } from './admin';
import { questionAvailabilityStatuses, questionCatalogStatuses, questionImportStatuses, questionOrigins, questionRightsStatuses, questionImportProgressSchema, questionSessionSummaryPublicSchema } from './question-catalog';

const cursor = z.string().min(1).max(2048).refine(v => v.trim().length > 0, 'empty_cursor');
const search = z.string().trim().min(1).max(200);
const limit = (maximum: number, fallback: number) => z.union([z.number().int(), z.string().regex(/^[1-9]\d*$/)]).pipe(z.coerce.number().int().min(1).max(maximum)).default(fallback);
/** Reject null, numeric epochs and invalid dates; accept Date or ISO wire timestamp. */
const date = z.union([z.date(), z.string().datetime({ offset: true })]).pipe(timestampSchema);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, 'invalid_calendar_date');
const pageFields = { limit: limit(50,25), cursor: cursor.optional() };
export const questionAdminCatalogQuerySchema = z.object({ ...pageFields, search: search.optional(), status: z.enum(questionCatalogStatuses).optional(), sourceId: idSchema.optional(), type: z.enum(['objective','discursive']).optional(), versions: z.enum(['latest','all']).default('latest') }).strict();
export type QuestionAdminCatalogQuery = z.infer<typeof questionAdminCatalogQuerySchema>;
export const questionAdminCatalogItemSchema = z.object({ id:idSchema, canonicalId:idSchema, supersedesId:idSchema.nullable(), version:z.number().int().positive(), type:z.enum(['objective','discursive']), origin:z.enum(questionOrigins), stemPreview:z.string().max(300), catalogStatus:z.enum(questionCatalogStatuses), rightsStatus:z.enum(questionRightsStatuses), availability:z.enum(questionAvailabilityStatuses), sourceId:idSchema.nullable(), sourceLabel:z.string().max(300).nullable(), contentHash:hash.nullable(), reviewedHash:hash.nullable(), createdAt:date, updatedAt:date, publishedAt:date.nullable() }).strict();
export type QuestionAdminCatalogItem = z.infer<typeof questionAdminCatalogItemSchema>;
export const questionAdminCatalogPageSchema = z.object({ items:z.array(questionAdminCatalogItemSchema).max(50), nextCursor:cursor.nullable() }).strict();
export const questionAdminCatalogResultSchema = questionAdminCatalogPageSchema.extend({ audit:auditEntrySchema }).strict();
export type QuestionAdminCatalogPage = z.infer<typeof questionAdminCatalogPageSchema>;
export const questionImportPageQuerySchema = z.object({ ...pageFields, search:search.optional(), status:z.enum(questionImportStatuses).optional(), sourceId:idSchema.optional() }).strict();
export type QuestionImportPageQuery = z.infer<typeof questionImportPageQuerySchema>;
export const questionImportPageResultSchema = z.object({ items:z.array(questionImportProgressSchema).max(50), nextCursor:cursor.nullable(), audit:auditEntrySchema }).strict();
export const questionHistoryQuerySchema = z.object(pageFields).strict();
export type QuestionHistoryQuery = z.infer<typeof questionHistoryQuerySchema>;
/** One existing canonical/supersedes chain; item order and cursor are server-defined. */
export const questionVersionHistoryPageSchema = z.object({ questionId:idSchema, canonicalId:idSchema, items:z.array(questionAdminCatalogItemSchema).max(50), nextCursor:cursor.nullable() }).strict();
export const questionVersionHistoryResultSchema = questionVersionHistoryPageSchema.extend({ audit:auditEntrySchema }).strict();
export const questionReviewHistoryItemSchema = z.object({ id:idSchema, questionId:idSchema, decision:z.enum(['approved','changes_requested','rejected']), contentHash:hash, reason:reasonSchema, reviewerName:z.string().min(1).max(300), reviewerCrm:z.string().min(1).max(100), referenceDate:calendarDate, reviewedAt:date }).strict();
export type QuestionReviewHistoryItem = z.infer<typeof questionReviewHistoryItemSchema>;
export const questionReviewHistoryPageSchema = z.object({ questionId:idSchema, items:z.array(questionReviewHistoryItemSchema).max(50), nextCursor:cursor.nullable() }).strict();
export const questionReviewHistoryResultSchema = questionReviewHistoryPageSchema.extend({ audit:auditEntrySchema }).strict();
export const questionSessionsPageQuerySchema = z.object({ limit:limit(20,20), cursor:cursor.optional(), status:z.enum(['active','finished','expired']).optional(), mode:z.enum(['study','simulation']).optional() }).strict();
export type QuestionSessionsPageQuery = z.infer<typeof questionSessionsPageQuerySchema>;
const sessionSummary = questionSessionSummaryPublicSchema.extend({ startedAt:date, deadline:date.nullable(), finishedAt:date.nullable(), serverTime:date }).strict();
export const questionSessionsPageResultSchema = z.object({ items:z.array(sessionSummary).max(20), nextCursor:cursor.nullable() }).strict();
export type QuestionSessionsPageResult = z.infer<typeof questionSessionsPageResultSchema>;

export type QuestionAdminCatalogResult = z.infer<typeof questionAdminCatalogResultSchema>;
export type QuestionImportPageResult = z.infer<typeof questionImportPageResultSchema>;
export type QuestionVersionHistoryPage = z.infer<typeof questionVersionHistoryPageSchema>;
export type QuestionVersionHistoryResult = z.infer<typeof questionVersionHistoryResultSchema>;
export type QuestionReviewHistoryPage = z.infer<typeof questionReviewHistoryPageSchema>;
export type QuestionReviewHistoryResult = z.infer<typeof questionReviewHistoryResultSchema>;
