import { z } from 'zod';
import { editorialStatuses, flagSources } from './enums';
import { idSchema, timestampSchema } from './common';
import { cardDetailSchema } from './card';
import { edgeSchema } from './board';

export const reviewItemSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  boardId: idSchema,
  status: z.enum(editorialStatuses),
  reviewerId: idSchema.nullable(),
  note: z.string().nullable(),
  /** null = draft card awaiting first review; otherwise why it was flagged. */
  flagSource: z.enum(flagSources).nullable(),
  /** Disputed attempt (flagSource = user_disagree). */
  attemptId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

/** approveCard / requestChange / rejectCard. Reviewer identity (name + CRM) comes from the session. */
export const reviewDecisionSchema = z.object({
  reviewItemId: idSchema,
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  note: z.string().nullable(),
});
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const disputeOutcomes = ['rubric_correct', 'rubric_adjusted'] as const;
export const resolveDisputeInputSchema = z.object({
  reviewItemId: idSchema,
  outcome: z.enum(disputeOutcomes),
  note: z.string().nullable(),
});
export type ResolveDisputeInput = z.infer<typeof resolveDisputeInputSchema>;

export const publishVersionInputSchema = z.object({ boardId: idSchema, changelog: z.string().min(1), temporalMark: z.string().min(1) });
export type PublishVersionInput = z.infer<typeof publishVersionInputSchema>;

export const boardVersionSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  version: z.number().int().positive(),
  changelog: z.string(),
  temporalMark: z.string(),
  snapshot: z.object({ cards: z.array(cardDetailSchema), edges: z.array(edgeSchema) }),
  reviewerId: idSchema,
  approvedAt: timestampSchema,
});
export type BoardVersion = z.infer<typeof boardVersionSchema>;
