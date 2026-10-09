-- Custom SQL migration file, put your code below! --
-- Source-only migration: no schema projection changes. Apply only after isolated SQL QA.
-- Source PK remains immutable in the API; its caller must use FOR NO KEY UPDATE,
-- compatible with FK KEY SHARE. Do not acquire source SHARE after graph locks.
CREATE OR REPLACE FUNCTION public.f33_source_rights_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
 -- Lock the complete source set, including drafts. The API also updates draft
 -- rights after this trigger. Sorted phases match recovery's paper → question order.
 PERFORM p.id FROM public.exam_papers p WHERE p.source_id = NEW.id
 ORDER BY p.id FOR UPDATE;
 PERFORM q.id FROM public.question_bank q WHERE q.source_id = NEW.id
 ORDER BY q.id FOR UPDATE;
 IF NEW.rights_status <> 'authorized' OR (NEW.rights_expires_at IS NOT NULL AND NEW.rights_expires_at <= now()) THEN
  UPDATE public.question_bank SET catalog_status = 'withdrawn', rights_status = NEW.rights_status
  WHERE source_id = NEW.id AND catalog_status = 'published';
  UPDATE public.exam_papers SET status = 'withdrawn' WHERE source_id = NEW.id AND status = 'published';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_source_rights_change() FROM PUBLIC, anon, authenticated;
