ALTER TYPE "public"."card_type" ADD VALUE 'note';--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "back_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_back_asset_id_assets_id_fk" FOREIGN KEY ("back_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_back_asset_idx" ON "cards" USING btree ("back_asset_id") WHERE "cards"."back_asset_id" is not null;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_size_chk" CHECK (("cards"."width" is null and "cards"."height" is null) or ("cards"."width" between 140 and 640 and "cards"."height" between 90 and 560));--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_tags_chk" CHECK (cardinality("cards"."tags") <= 50);--> statement-breakpoint
-- D-201: the back image and any step/stage image are readable like the payload asset (0003) and front asset (0010).
DROP POLICY assets_select_via_card ON public.assets;--> statement-breakpoint
CREATE POLICY assets_select_via_card ON public.assets FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.cards c
    WHERE c.deleted_at IS NULL AND (
      c.payload ->> 'assetId' = assets.id::text OR c.front_asset_id = assets.id OR c.back_asset_id = assets.id
      OR jsonb_path_exists(c.payload, '$.steps[*].assetId ? (@ == $id)', jsonb_build_object('id', assets.id::text))
      OR jsonb_path_exists(c.payload, '$.caseSteps[*].assetId ? (@ == $id)', jsonb_build_object('id', assets.id::text))
    )
  )
);
