ALTER TABLE "masks" DROP CONSTRAINT "masks_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "masks" ADD CONSTRAINT "masks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;