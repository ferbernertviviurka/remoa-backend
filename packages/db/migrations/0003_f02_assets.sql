-- Custom SQL migration file, put your code below! ---- F02: an asset is readable by whoever can read a live card that points at it (seed images); writes stay owner-only (assets_own).
CREATE POLICY assets_select_via_card ON public.assets FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.cards c WHERE c.payload ->> 'assetId' = assets.id::text AND c.deleted_at IS NULL)
);
--> statement-breakpoint
CREATE INDEX cards_payload_asset_idx ON public.cards ((payload ->> 'assetId')) WHERE type = 'image';
