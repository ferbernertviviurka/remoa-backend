CREATE INDEX "question_bank_canonical_latest_idx" ON "question_bank" USING btree (coalesce("canonical_id", "id"),"version","created_at","id");--> statement-breakpoint
CREATE INDEX "question_bank_stem_trgm_idx" ON "question_bank" USING gin ("stem" gin_trgm_ops);
--> statement-breakpoint
-- Source withdrawal changes distribution rights, preserving intrinsic availability and signed content.
CREATE OR REPLACE FUNCTION public.f33_source_rights_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
 IF NEW.rights_status <> 'authorized' OR (NEW.rights_expires_at IS NOT NULL AND NEW.rights_expires_at <= now()) THEN
  UPDATE public.question_bank SET catalog_status = 'withdrawn', rights_status = NEW.rights_status
  WHERE source_id = NEW.id AND catalog_status = 'published';
  UPDATE public.exam_papers SET status = 'withdrawn' WHERE source_id = NEW.id AND status = 'published';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_source_rights_change() FROM PUBLIC, anon, authenticated;
