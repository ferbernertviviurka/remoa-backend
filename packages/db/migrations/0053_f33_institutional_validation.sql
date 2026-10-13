-- D-1819 (F33/G26) source only; NOT applied by this task. Rule-6 exception (extends D-1522): remoa_authored institutional
-- questions may be published with the Remoa seal ("Validado pela Remoa") after the Remoa medical founder's attestation, via the
-- audited admin action question.institutional_approve. The seal never carries a CRM and never sets integrity_confirmed/key_final/
-- enamed_confirmed (attested, not confirmed). Medical-review publication is unchanged.
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_publish_chk";--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" DROP CONSTRAINT "question_editorial_identity_chk";--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ALTER COLUMN "reviewer_crm" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "validation_kind" text DEFAULT 'medical_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD COLUMN "kind" text DEFAULT 'medical_review' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "question_sources_remoa_owned_uq" ON "question_sources" USING btree ("rights_scope") WHERE "question_sources"."rights_scope" = 'remoa_owned';--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_validation_kind_chk" CHECK ("question_bank"."validation_kind" in ('medical_review', 'remoa_institutional'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_publish_chk" CHECK ("question_bank"."catalog_status" <> 'published' or ("question_bank"."visibility" = 'public' and "question_bank"."rights_status" = 'authorized' and "question_bank"."status" = 'approved' and "question_bank"."enamed_area_id" is not null and "question_bank"."enamed_topic_id" is not null and "question_bank"."content_hash" is not null and "question_bank"."reviewed_hash" is not null and "question_bank"."reviewed_hash" = "question_bank"."content_hash" and nullif(btrim("question_bank"."reviewer_name"),'') is not null and "question_bank"."reference_date" is not null and (("question_bank"."validation_kind" = 'medical_review' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and nullif(btrim("question_bank"."reviewer_crm"),'') is not null) or ("question_bank"."validation_kind" = 'remoa_institutional' and "question_bank"."user_id" is null and "question_bank"."origin" = 'remoa_authored' and "question_bank"."reviewer_crm" is null and "question_bank"."correct_key" is not null))));--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_kind_chk" CHECK ("question_editorial_reviews"."kind" in ('medical_review','remoa_institutional'));--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_identity_chk" CHECK (length(btrim("question_editorial_reviews"."reviewer_name")) > 0 and length(btrim("question_editorial_reviews"."reason")) >= 8 and case "question_editorial_reviews"."kind" when 'medical_review' then nullif(btrim("question_editorial_reviews"."reviewer_crm"),'') is not null else "question_editorial_reviews"."reviewer_crm" is null and "question_editorial_reviews"."decision" = 'approved' end);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.f33_validate_signature() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE signer public.profiles%ROWTYPE; crm text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.question_bank q WHERE q.id=OLD.question_id AND q.visibility='public') THEN RAISE EXCEPTION 'institutional_signature_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  -- The FK may erase the account identifier; signed name/CRM/date/hash remain unchanged.
  IF (NEW.id,NEW.question_id,NEW.kind,NEW.reviewer_name,NEW.reviewer_crm,NEW.content_hash,NEW.decision,NEW.reason,NEW.reference_date,NEW.reviewed_at)
   IS DISTINCT FROM (OLD.id,OLD.question_id,OLD.kind,OLD.reviewer_name,OLD.reviewer_crm,OLD.content_hash,OLD.decision,OLD.reason,OLD.reference_date,OLD.reviewed_at)
   OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'medical_signature_immutable';END IF;
  RETURN NEW;
 END IF;
 -- D-1819: Remoa institutional attestation. Active admin attributes it; founder display name, never a CRM; Remoa-owned scope only.
 IF NEW.kind='remoa_institutional' THEN
  SELECT * INTO signer FROM public.profiles WHERE user_id=NEW.user_id AND role='admin' AND deleted_at IS NULL AND suspended_at IS NULL;
  IF signer.user_id IS NULL THEN RAISE EXCEPTION 'active_admin_required';END IF;
  IF NEW.reviewer_crm IS NOT NULL OR NEW.decision<>'approved' OR nullif(btrim(NEW.reviewer_name),'') IS NULL OR NEW.reviewer_name ~ '[0-9]'
  THEN RAISE EXCEPTION 'invalid_institutional_attestation';END IF;
  IF NOT public.f33_calendar_date(NEW.reference_date) THEN RAISE EXCEPTION 'invalid_reference_calendar_date';END IF;
  IF NEW.content_hash !~ '^[a-f0-9]{64}$' OR NOT EXISTS(SELECT 1 FROM public.question_bank q JOIN public.question_sources s ON s.id=q.source_id
    WHERE q.id=NEW.question_id AND q.content_hash=NEW.content_hash AND q.user_id IS NULL AND q.visibility='public' AND q.origin='remoa_authored'
      AND s.rights_scope='remoa_owned' AND s.rights_status='authorized')
  THEN RAISE EXCEPTION 'institutional_scope_required';END IF;
  NEW.reviewer_name:=btrim(NEW.reviewer_name);
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
   (NEW.stem, NEW.alternatives, NEW.correct_key, NEW.expected_answer, NEW.explanation, NEW.key_points, NEW.distractor_notes, NEW.assets,NEW.type,NEW.difficulty,NEW.evidences,NEW.enamed_area_id,NEW.enamed_domain_id,NEW.enamed_competency_id,NEW.enamed_topic_id,NEW.origin,NEW.source_id,NEW.content_hash,NEW.reviewed_hash,NEW.reviewer_name,NEW.reviewer_crm,NEW.validation_kind,NEW.reference_date,NEW.version,NEW.canonical_id,NEW.supersedes_id)
   IS DISTINCT FROM (OLD.stem, OLD.alternatives, OLD.correct_key, OLD.expected_answer, OLD.explanation, OLD.key_points, OLD.distractor_notes, OLD.assets,OLD.type,OLD.difficulty,OLD.evidences,OLD.enamed_area_id,OLD.enamed_domain_id,OLD.enamed_competency_id,OLD.enamed_topic_id,OLD.origin,OLD.source_id,OLD.content_hash,OLD.reviewed_hash,OLD.reviewer_name,OLD.reviewer_crm,OLD.validation_kind,OLD.reference_date,OLD.version,OLD.canonical_id,OLD.supersedes_id)
 THEN RAISE EXCEPTION 'published_content_immutable_create_version'; END IF;
 IF NEW.catalog_status = 'published' THEN
  IF nullif(btrim(NEW.explanation),'') IS NULL THEN RAISE EXCEPTION 'reviewed_explanation_required'; END IF;
  IF NEW.content_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_content_hash'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_sources s WHERE s.id = NEW.source_id AND s.rights_status = 'authorized' AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now())) THEN RAISE EXCEPTION 'source_rights_required'; END IF;
  IF NEW.validation_kind='remoa_institutional' THEN
   -- D-1819: only Remoa-owned, institutional remoa_authored content with a final key may carry the Remoa seal.
   IF NEW.origin<>'remoa_authored' OR NEW.user_id IS NOT NULL OR NEW.reviewer_crm IS NOT NULL OR NEW.correct_key IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.question_sources s WHERE s.id=NEW.source_id AND s.rights_scope='remoa_owned')
   THEN RAISE EXCEPTION 'institutional_scope_required';END IF;
   IF (TG_OP='INSERT' OR OLD.catalog_status<>'published') AND NOT public.f33_calendar_date(NEW.reference_date) THEN RAISE EXCEPTION 'invalid_institutional_attestation';END IF;
  ELSIF TG_OP='INSERT' OR OLD.catalog_status<>'published' THEN
   NEW.reviewer_crm:=public.f33_normalize_crm(NEW.reviewer_crm);
   IF NEW.reviewer_crm IS NULL OR NOT public.f33_calendar_date(NEW.reference_date) THEN RAISE EXCEPTION 'invalid_medical_signature';END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_editorial_reviews r
    WHERE r.question_id=NEW.id AND r.content_hash=NEW.content_hash AND r.decision='approved'
      AND r.kind=NEW.validation_kind AND r.reviewer_crm IS NOT DISTINCT FROM NEW.reviewer_crm AND r.reviewer_name=NEW.reviewer_name AND r.reference_date=NEW.reference_date
      AND r.id=(SELECT last.id FROM public.question_editorial_reviews last WHERE last.question_id=NEW.id AND last.content_hash=NEW.content_hash ORDER BY last.reviewed_at DESC,last.id DESC LIMIT 1))
  THEN IF NEW.validation_kind='remoa_institutional' THEN RAISE EXCEPTION 'institutional_review_required'; END IF; RAISE EXCEPTION 'medical_review_required'; END IF;
  IF NOT EXISTS (WITH RECURSIVE lineage AS (
    SELECT t.id,t.parent_id,t.kind,t.area,0 depth,ARRAY[t.id] path,false cycle FROM public.enamed_taxonomy t WHERE t.id=NEW.enamed_topic_id AND t.kind='topic'
    UNION ALL SELECT p.id,p.parent_id,p.kind,p.area,l.depth+1,l.path||p.id,p.id=ANY(l.path) FROM public.enamed_taxonomy p JOIN lineage l ON p.id=l.parent_id WHERE l.depth<10 AND NOT l.cycle
   ) SELECT 1 FROM lineage l JOIN public.enamed_taxonomy a ON a.id=NEW.enamed_area_id AND a.kind='area' WHERE l.id=a.id AND NOT EXISTS(SELECT 1 FROM lineage bad WHERE bad.area<>a.area OR bad.cycle OR (bad.depth=10 AND bad.parent_id IS NOT NULL)))
  THEN RAISE EXCEPTION 'invalid_public_question_taxonomy';END IF;

 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_validate_question() FROM PUBLIC,anon,authenticated;
