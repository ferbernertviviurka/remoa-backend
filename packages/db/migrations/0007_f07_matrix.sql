CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
UPDATE "matrix_items" SET "target_cards" = 40 WHERE "target_cards" IS NULL;--> statement-breakpoint
ALTER TABLE "matrix_items" ALTER COLUMN "target_cards" SET DEFAULT 40;--> statement-breakpoint
ALTER TABLE "matrix_items" ALTER COLUMN "target_cards" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matrix_items" ADD COLUMN "temporal_mark" text;
