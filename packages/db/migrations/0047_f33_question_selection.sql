CREATE INDEX "question_bank_created_id_idx" ON "question_bank" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
-- Custom DDL: Drizzle snapshots do not represent expression statistics. Ownership follows the migration/table owner.
-- IS TRUE uses this Boolean expression's distribution without weakening the signed-content equality gate.
CREATE STATISTICS public."question_bank_review_match_stats" ON (reviewed_hash = content_hash) FROM public.question_bank;
--> statement-breakpoint
ANALYZE public.question_bank;
