/** CCR131: private PNG of the original exam page; coordinates are normalized against the rotated image. */
import { z } from 'zod';
import { idSchema } from './common';
import { auditEntrySchema } from './admin';
import { questionProvenanceSchema } from './question-catalog';
const pageImageSchema = z.object({
  importId: idSchema, documentId: idSchema,
  page: z.number().int().min(1).max(500), pages: z.number().int().min(1).max(500),
  width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000),
  dpi: z.literal(100), documentSha256: z.string().regex(/^[a-f0-9]{64}$/), imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().url().refine(url => /^https?:\/\//i.test(url), 'http_url_required'), expiresInSec: z.literal(300),
  provenance: questionProvenanceSchema,
}).strict();
const pageRefinement = (value: z.infer<typeof pageImageSchema>, ctx: z.RefinementCtx) => {
  if (value.width * value.height > 20000000) ctx.addIssue({ code: 'custom', path: ['width'], message: 'pixel_limit' });
  if (value.page > value.pages) ctx.addIssue({ code: 'custom', path: ['page'], message: 'page_out_of_bounds' });
  if (value.provenance.documentId !== value.documentId || value.provenance.page !== value.page || JSON.stringify(value.provenance.bbox) !== '[0,0,1,1]')
    ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'full_original_page_required' });
};
export const questionDocumentPageImageSchema = pageImageSchema.superRefine(pageRefinement);
export const questionDocumentPagePreviewSchema = pageImageSchema.extend({ audit: auditEntrySchema }).superRefine(pageRefinement);
export type QuestionDocumentPagePreview = z.infer<typeof questionDocumentPagePreviewSchema>;
