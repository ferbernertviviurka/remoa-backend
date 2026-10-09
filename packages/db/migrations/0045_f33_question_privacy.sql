ALTER TABLE "question_documents" DROP CONSTRAINT "question_documents_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" DROP CONSTRAINT "question_editorial_reviews_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "question_imports" DROP CONSTRAINT "question_imports_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "question_documents" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_imports" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_documents" ADD CONSTRAINT "question_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- CCR113: validate a new signer now, preserve the immutable signature after role/account changes.
CREATE FUNCTION public.f33_calendar_date(raw text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE parsed date;
BEGIN
 IF raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
 parsed:=raw::date;
 RETURN to_char(parsed,'YYYY-MM-DD')=raw;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.f33_normalize_crm(raw text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE value text; parts text[]; uf text; number text;
BEGIN
 value:=upper(regexp_replace(btrim(raw),'\s+','','g'));
 value:=regexp_replace(value,'^CRM[-/]?','');
 parts:=regexp_match(value,'^([A-Z]{2})[-/]?([0-9]{1,10})$');
 IF parts IS NOT NULL THEN uf:=parts[1];number:=parts[2];
 ELSE parts:=regexp_match(value,'^([0-9]{1,10})[-/]?([A-Z]{2})$');IF parts IS NULL THEN RETURN NULL;END IF;number:=parts[1];uf:=parts[2];END IF;
 IF uf NOT IN ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') OR number::bigint<=0 THEN RETURN NULL;END IF;
 RETURN number::bigint::text||'-'||uf;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_calendar_date(text),public.f33_normalize_crm(text) FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
CREATE FUNCTION public.f33_validate_signature() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE signer public.profiles%ROWTYPE; crm text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.question_bank q WHERE q.id=OLD.question_id AND q.visibility='public') THEN RAISE EXCEPTION 'institutional_signature_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  -- The FK may erase the account identifier; signed name/CRM/date/hash remain unchanged.
  IF (NEW.id,NEW.question_id,NEW.reviewer_name,NEW.reviewer_crm,NEW.content_hash,NEW.decision,NEW.reason,NEW.reference_date,NEW.reviewed_at)
   IS DISTINCT FROM (OLD.id,OLD.question_id,OLD.reviewer_name,OLD.reviewer_crm,OLD.content_hash,OLD.decision,OLD.reason,OLD.reference_date,OLD.reviewed_at)
   OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'medical_signature_immutable';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO signer FROM public.profiles WHERE user_id=NEW.user_id AND role='reviewer' AND deleted_at IS NULL AND suspended_at IS NULL;
 crm:=public.f33_normalize_crm(signer.crm);
 IF signer.user_id IS NULL OR crm IS NULL OR nullif(btrim(signer.name),'') IS NULL
   OR btrim(NEW.reviewer_name)<>btrim(signer.name) OR public.f33_normalize_crm(NEW.reviewer_crm) IS DISTINCT FROM crm
 THEN RAISE EXCEPTION 'active_medical_reviewer_required';END IF;
 IF NOT public.f33_calendar_date(NEW.reference_date) THEN RAISE EXCEPTION 'invalid_reference_calendar_date';END IF;
 IF NEW.content_hash !~ '^[a-f0-9]{64}$' OR NOT EXISTS(SELECT 1 FROM public.question_bank q WHERE q.id=NEW.question_id AND q.content_hash=NEW.content_hash) THEN RAISE EXCEPTION 'review_content_hash_mismatch';END IF;
 NEW.reviewer_name:=btrim(signer.name);NEW.reviewer_crm:=crm;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_validate_signature() FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
CREATE TRIGGER f33_validate_signature BEFORE INSERT OR UPDATE OR DELETE ON public.question_editorial_reviews FOR EACH ROW EXECUTE FUNCTION public.f33_validate_signature();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.f33_validate_question() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE valid_keys integer; unique_keys integer; total integer;
BEGIN
 NEW.canonical_id := coalesce(NEW.canonical_id, (SELECT canonical_id FROM public.question_bank WHERE id = NEW.supersedes_id), NEW.id);
 IF NEW.type = 'objective' THEN
  SELECT count(*), count(DISTINCT value->>'key'), count(*) FILTER (WHERE value->>'key' IN ('A','B','C','D','E','F','G','H','I','J') AND jsonb_typeof(value->'text') = 'string' AND length(value->>'text') > 0)
  INTO total, unique_keys, valid_keys FROM jsonb_array_elements(NEW.alternatives);
  IF total <> unique_keys OR total <> valid_keys OR total NOT BETWEEN 2 AND 10 THEN RAISE EXCEPTION 'invalid_alternatives'; END IF;
  IF NEW.correct_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.alternatives) a WHERE a->>'key' = NEW.correct_key) THEN RAISE EXCEPTION 'key_not_in_alternatives'; END IF;
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.catalog_status = 'published' AND
   (NEW.stem, NEW.alternatives, NEW.correct_key, NEW.expected_answer, NEW.explanation, NEW.key_points, NEW.distractor_notes, NEW.assets,NEW.type,NEW.difficulty,NEW.evidences,NEW.enamed_area_id,NEW.enamed_domain_id,NEW.enamed_competency_id,NEW.enamed_topic_id,NEW.origin,NEW.source_id,NEW.content_hash,NEW.reviewed_hash,NEW.reviewer_name,NEW.reviewer_crm,NEW.reference_date,NEW.version,NEW.canonical_id,NEW.supersedes_id)
   IS DISTINCT FROM (OLD.stem, OLD.alternatives, OLD.correct_key, OLD.expected_answer, OLD.explanation, OLD.key_points, OLD.distractor_notes, OLD.assets,OLD.type,OLD.difficulty,OLD.evidences,OLD.enamed_area_id,OLD.enamed_domain_id,OLD.enamed_competency_id,OLD.enamed_topic_id,OLD.origin,OLD.source_id,OLD.content_hash,OLD.reviewed_hash,OLD.reviewer_name,OLD.reviewer_crm,OLD.reference_date,OLD.version,OLD.canonical_id,OLD.supersedes_id)
 THEN RAISE EXCEPTION 'published_content_immutable_create_version'; END IF;
 IF NEW.catalog_status = 'published' THEN
  IF nullif(btrim(NEW.explanation),'') IS NULL THEN RAISE EXCEPTION 'reviewed_explanation_required'; END IF;
  IF NEW.content_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_content_hash'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_sources s WHERE s.id = NEW.source_id AND s.rights_status = 'authorized' AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now())) THEN RAISE EXCEPTION 'source_rights_required'; END IF;
  IF TG_OP='INSERT' OR OLD.catalog_status<>'published' THEN
   NEW.reviewer_crm:=public.f33_normalize_crm(NEW.reviewer_crm);
   IF NEW.reviewer_crm IS NULL OR NOT public.f33_calendar_date(NEW.reference_date) THEN RAISE EXCEPTION 'invalid_medical_signature';END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_editorial_reviews r
    WHERE r.question_id=NEW.id AND r.content_hash=NEW.content_hash AND r.decision='approved'
      AND r.reviewer_crm=NEW.reviewer_crm AND r.reviewer_name=NEW.reviewer_name AND r.reference_date=NEW.reference_date
      AND r.id=(SELECT last.id FROM public.question_editorial_reviews last WHERE last.question_id=NEW.id AND last.content_hash=NEW.content_hash ORDER BY last.reviewed_at DESC,last.id DESC LIMIT 1))
  THEN RAISE EXCEPTION 'medical_review_required'; END IF;
  IF NOT EXISTS (WITH RECURSIVE lineage AS (
    SELECT t.id,t.parent_id,t.kind,t.area,0 depth,ARRAY[t.id] path,false cycle FROM public.enamed_taxonomy t WHERE t.id=NEW.enamed_topic_id AND t.kind='topic'
    UNION ALL SELECT p.id,p.parent_id,p.kind,p.area,l.depth+1,l.path||p.id,p.id=ANY(l.path) FROM public.enamed_taxonomy p JOIN lineage l ON p.id=l.parent_id WHERE l.depth<10 AND NOT l.cycle
   ) SELECT 1 FROM lineage l JOIN public.enamed_taxonomy a ON a.id=NEW.enamed_area_id AND a.kind='area' WHERE l.id=a.id AND NOT EXISTS(SELECT 1 FROM lineage bad WHERE bad.area<>a.area OR bad.cycle OR (bad.depth=10 AND bad.parent_id IS NOT NULL)))
  THEN RAISE EXCEPTION 'invalid_public_question_taxonomy';END IF;

 END IF;
 RETURN NEW;
END $$;


--> statement-breakpoint
ALTER TABLE public.question_bank DROP CONSTRAINT question_bank_board_id_boards_id_fk;
--> statement-breakpoint
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_board_id_boards_id_fk FOREIGN KEY(board_id) REFERENCES public.boards(id) ON DELETE SET NULL;
--> statement-breakpoint
-- A single auth.users deletion cascades to both the private question and its owner-ledger/session.
-- Check the NO ACTION links after all those cascades finish, while retaining historical links on normal operations.
ALTER TABLE public.question_generation_candidates ALTER CONSTRAINT question_generation_candidates_question_id_question_bank_id_fk DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.question_session_items ALTER CONSTRAINT question_session_items_question_id_question_bank_id_fk DEFERRABLE INITIALLY DEFERRED;
