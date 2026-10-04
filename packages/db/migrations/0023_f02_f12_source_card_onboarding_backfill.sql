ALTER TABLE "cards" ADD COLUMN "source_card_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_source_card_id_cards_id_fk" FOREIGN KEY ("source_card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_source_card_idx" ON "cards" USING btree ("source_card_id") WHERE "cards"."source_card_id" is not null;--> statement-breakpoint
-- Hand-written (CCR-016, D-531): link existing seed copies to their seed card by title (same rule D-497 used), oldest seed card wins.
UPDATE "cards" c SET "source_card_id" = (
  SELECT s.id FROM "cards" s WHERE s.board_id = b.source_board_id AND s.title = c.title AND s.deleted_at IS NULL ORDER BY s.created_at LIMIT 1
) FROM "boards" b, "boards" sb
WHERE b.id = c.board_id AND b.source_board_id = sb.id AND sb.status <> 'private' AND c.source_card_id IS NULL;--> statement-breakpoint
-- Hand-written (CCR-016, D-530): accounts that exist before the onboarding (D-492/D-526) are not sent through it.
UPDATE "profiles" SET "onboarding_done_at" = now() WHERE "onboarding_done_at" IS NULL;
