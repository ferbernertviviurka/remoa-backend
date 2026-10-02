CREATE TYPE "public"."card_shape" AS ENUM('rect', 'pill', 'circle', 'diamond', 'hexagon');--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "shape" "card_shape" DEFAULT 'rect' NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "front_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_front_asset_id_assets_id_fk" FOREIGN KEY ("front_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- D-096: a question image (front_asset_id) is readable like a card payload asset (0003).
DROP POLICY assets_select_via_card ON public.assets;--> statement-breakpoint
CREATE POLICY assets_select_via_card ON public.assets FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.cards c WHERE (c.payload ->> 'assetId' = assets.id::text OR c.front_asset_id = assets.id) AND c.deleted_at IS NULL)
);--> statement-breakpoint
CREATE INDEX cards_front_asset_idx ON public.cards (front_asset_id) WHERE front_asset_id IS NOT NULL;
