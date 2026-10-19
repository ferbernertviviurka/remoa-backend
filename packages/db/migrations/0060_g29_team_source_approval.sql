-- D-1885 / CCR-172: a human Remoa source attestation, not a claim of third-party licensing.
-- Preserve0059, question rights/hash/signatures and the frozen manifest. Revoked/restricted/expired sources fail closed.
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
   (NEW.stem, NEW.alternatives, NEW.correct_key, NEW.expected_answer, NEW.explanation, NEW.key_points, NEW.distractor_notes, NEW.assets,NEW.type,NEW.difficulty,NEW.evidences,NEW.enamed_area_id,NEW.enamed_domain_id,NEW.enamed_competency_id,NEW.enamed_topic_id,NEW.origin,NEW.source_id,NEW.content_hash,NEW.reviewed_hash,NEW.reviewer_name,NEW.reviewer_crm,NEW.validation_kind,NEW.reference_date,NEW.version,NEW.canonical_id,NEW.supersedes_id,NEW.profession_code)
   IS DISTINCT FROM (OLD.stem, OLD.alternatives, OLD.correct_key, OLD.expected_answer, OLD.explanation, OLD.key_points, OLD.distractor_notes, OLD.assets,OLD.type,OLD.difficulty,OLD.evidences,OLD.enamed_area_id,OLD.enamed_domain_id,OLD.enamed_competency_id,OLD.enamed_topic_id,OLD.origin,OLD.source_id,OLD.content_hash,OLD.reviewed_hash,OLD.reviewer_name,OLD.reviewer_crm,OLD.validation_kind,OLD.reference_date,OLD.version,OLD.canonical_id,OLD.supersedes_id,OLD.profession_code)
 THEN RAISE EXCEPTION 'published_content_immutable_create_version'; END IF;
 IF TG_OP='UPDATE' AND OLD.catalog_status='published' AND OLD.validation_kind='remoa_team_attested' AND (NEW.availability,NEW.key_final,NEW.integrity_confirmed,NEW.enamed_confirmed,NEW.user_id) IS DISTINCT FROM (OLD.availability,OLD.key_final,OLD.integrity_confirmed,OLD.enamed_confirmed,OLD.user_id) THEN RAISE EXCEPTION 'team_scope_immutable';END IF;
 IF NEW.catalog_status = 'published' THEN
  IF NEW.validation_kind='remoa_team_attested' THEN
   IF NEW.origin IS DISTINCT FROM 'official_exam' OR NEW.visibility IS DISTINCT FROM 'public' OR NEW.user_id IS NOT NULL OR NEW.rights_status IS DISTINCT FROM 'pending'
     OR NEW.reviewer_name IS DISTINCT FROM 'Remoa' OR NEW.reviewer_crm IS NOT NULL OR NEW.reference_date IS DISTINCT FROM '2026-10-19'
     OR NOT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_team_batches b ON b.id=i.batch_id JOIN public.question_sources s ON s.id=i.source_id
       WHERE i.question_id=NEW.id AND i.content_hash=NEW.content_hash AND i.source_id=NEW.source_id AND i.profession_code=NEW.profession_code
       AND b.revoked_at IS NULL AND (s.rights_status='pending' OR (s.rights_status='authorized' AND s.rights_scope='g29-cp21-20261019' AND s.rights_evidence='Aprovado por Remoa' AND s.rights_expires_at IS NOT NULL)) AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now())
       AND NEW.reviewed_hash=i.content_hash AND i.content_hash=public.f33_team_content_hash(NEW) AND i.scope_hash=public.f33_team_scope_hash(i,NEW)
       AND ((('annulled'=ANY(i.flags)) AND NEW.availability='annulled') OR (NOT ('annulled'=ANY(i.flags)) AND NEW.availability=CASE WHEN i.flags&&ARRAY['key_conflict','image_missing']::text[] THEN 'unavailable' ELSE 'active' END))
       AND EXISTS(SELECT 1 FROM public.question_editorial_reviews r WHERE r.question_id=NEW.id AND r.kind='remoa_team_attested' AND r.decision='approved'
         AND r.content_hash=i.content_hash AND r.team_scope_hash=i.scope_hash AND r.reviewer_name='Remoa' AND r.reviewer_crm IS NULL AND r.reference_date=NEW.reference_date
         AND r.id=(SELECT latest.id FROM public.question_editorial_reviews latest WHERE latest.question_id=NEW.id AND latest.content_hash=NEW.content_hash ORDER BY latest.reviewed_at DESC,latest.id DESC LIMIT 1)))
   THEN RAISE EXCEPTION 'team_membership_signature_required';END IF;
   RETURN NEW;
  END IF;
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
CREATE OR REPLACE FUNCTION public.f33_team_question_visible(qid uuid,chash text) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_team_batches b ON b.id=i.batch_id JOIN public.question_bank q ON q.id=i.question_id JOIN public.question_sources s ON s.id=i.source_id
 WHERE i.question_id=qid AND i.content_hash=chash AND q.content_hash=i.content_hash AND q.reviewed_hash=i.content_hash AND q.source_id=i.source_id AND q.profession_code=i.profession_code
 AND q.visibility='public' AND q.catalog_status='published' AND q.status='approved' AND q.origin='official_exam' AND q.user_id IS NULL AND q.validation_kind='remoa_team_attested'
 AND q.rights_status='pending' AND (s.rights_status='pending' OR (s.rights_status='authorized' AND s.rights_scope='g29-cp21-20261019' AND s.rights_evidence='Aprovado por Remoa' AND s.rights_expires_at IS NOT NULL)) AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now())
 AND b.sealed_at IS NOT NULL AND b.activated_at IS NOT NULL AND b.revoked_at IS NULL)
$$;

--> statement-breakpoint
-- Team rows are signed WORM publications: source revocation hides them through the source predicate,
-- without rewriting their question rights/catalogue metadata. Legacy questions and papers retain0050 behavior.
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
  WHERE source_id = NEW.id AND catalog_status = 'published'
    AND validation_kind IS DISTINCT FROM 'remoa_team_attested';
  UPDATE public.exam_papers SET status = 'withdrawn' WHERE source_id = NEW.id AND status = 'published';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_source_rights_change() FROM PUBLIC, anon, authenticated;
