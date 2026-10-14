-- PROPOSED next available migration / CCR150 / D1845. SOURCE REVIEW ONLY. NOT journaled, generated or applied.
-- No legacy classification/backfill. Skills Supabase/Postgres loaded. No EXPLAIN or live SQL proof.
-- Execute only after owning schema/contract/runtime lanes integrate and isolated PG17 tests pass.
-- Requires baseline0000..0056. Source-revision and taxonomy metadata are private except reviewed taxonomy labels.
-- Scope hash is PostgreSQL jsonb canonical text SHA256, NOT the existing clinical JS hash algorithm.
-- Runtime must obtain this scope hash through the SQL helper; never hash JS JSON.stringify and claim equivalence.

CREATE TABLE public.health_taxonomy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profession_code text NOT NULL, kind text NOT NULL,
 parent_id uuid, code text NOT NULL, label text NOT NULL, revision integer NOT NULL,
 status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT health_taxonomy_id_profession_uq UNIQUE(id,profession_code),
 CONSTRAINT health_taxonomy_code_revision_uq UNIQUE(profession_code,code,revision),
 CONSTRAINT health_taxonomy_parent_profession_fk FOREIGN KEY(parent_id,profession_code) REFERENCES public.health_taxonomy(id,profession_code),
 CONSTRAINT health_taxonomy_profession_chk CHECK(profession_code IN ('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy')),
 CONSTRAINT health_taxonomy_kind_chk CHECK(kind IN ('area','topic','general')),
 CONSTRAINT health_taxonomy_status_chk CHECK(status IN ('draft','reviewed','withdrawn')),
 CONSTRAINT health_taxonomy_revision_chk CHECK(revision>0),
 CONSTRAINT health_taxonomy_parent_chk CHECK((kind='area')=(parent_id IS NULL) AND parent_id IS DISTINCT FROM id),
 CONSTRAINT health_taxonomy_labels_chk CHECK(code~'^[a-zA-Z0-9_.-]{1,100}$' AND length(btrim(label)) BETWEEN 1 AND 300)
);
CREATE INDEX health_taxonomy_parent_idx ON public.health_taxonomy(parent_id);
CREATE INDEX health_taxonomy_profession_status_idx ON public.health_taxonomy(profession_code,status);
CREATE TABLE public.question_source_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES public.question_sources(id),
 revision integer NOT NULL, revision_label text NOT NULL, manifest_sha256 text NOT NULL,
 documents jsonb NOT NULL, license jsonb NOT NULL, attribution jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft', verified_at timestamptz,
 actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT question_source_revisions_source_revision_uq UNIQUE(source_id,revision),
 CONSTRAINT question_source_revisions_revision_chk CHECK(revision>0),
 CONSTRAINT question_source_revisions_label_chk CHECK(length(btrim(revision_label)) BETWEEN 1 AND 200),
 CONSTRAINT question_source_revisions_hash_chk CHECK(manifest_sha256~'^[a-f0-9]{64}$'),
 CONSTRAINT question_source_revisions_status_chk CHECK(status IN ('draft','verified','withdrawn')),
 CONSTRAINT question_source_revisions_json_chk CHECK(jsonb_typeof(documents)='array' AND jsonb_typeof(license)='object' AND jsonb_typeof(attribution)='object' AND octet_length(documents::text)<=65536 AND octet_length(license::text)<=8192 AND octet_length(attribution::text)<=16384),
 CONSTRAINT question_source_revisions_verified_chk CHECK(status<>'verified' OR (verified_at IS NOT NULL AND license->>'scope'='licensed_external' AND license->>'verified'='true') IS TRUE)
);
CREATE INDEX question_source_revisions_actor_idx ON public.question_source_revisions(actor_id);

ALTER TABLE public.question_bank
 ADD COLUMN profession_code text, ADD COLUMN profession_tags text[], ADD COLUMN profession_verified boolean,
 ADD COLUMN language_tag text, ADD COLUMN language_verified boolean,
 ADD COLUMN health_area_id uuid REFERENCES public.health_taxonomy(id), ADD COLUMN health_topic_id uuid REFERENCES public.health_taxonomy(id),
 ADD COLUMN health_taxonomy_verified boolean,
 ADD COLUMN source_revision_id uuid REFERENCES public.question_source_revisions(id),
 ADD COLUMN explanation_status text, ADD COLUMN explanation_review_id uuid REFERENCES public.question_editorial_reviews(id),
 ADD COLUMN curation_personal_data_status text, ADD COLUMN curation_scope jsonb, ADD COLUMN curation_scope_hash text, ADD COLUMN curation_reviewed_scope_hash text;
ALTER TABLE public.question_editorial_reviews
 ADD COLUMN source_revision_id uuid REFERENCES public.question_source_revisions(id),
 ADD COLUMN curation_scope_hash text, ADD COLUMN curation_scope_snapshot jsonb, ADD COLUMN curation_personal_data_status text;
CREATE INDEX question_bank_source_revision_idx ON public.question_bank(source_revision_id);
CREATE INDEX question_bank_health_area_idx ON public.question_bank(health_area_id);
CREATE INDEX question_bank_health_topic_idx ON public.question_bank(health_topic_id);
CREATE INDEX question_bank_explanation_review_idx ON public.question_bank(explanation_review_id);
CREATE INDEX question_reviews_source_revision_idx ON public.question_editorial_reviews(source_revision_id);
-- Filter/order index candidate: no performance claim; verify EXPLAIN in isolated dataset before reservation.
CREATE INDEX question_bank_health_catalog_idx ON public.question_bank(profession_code,language_tag,catalog_status,created_at DESC,id DESC) WHERE visibility='public';

ALTER TABLE public.question_bank DROP CONSTRAINT question_bank_origin_chk;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_origin_chk CHECK(origin IN ('official_exam','licensed_dataset','remoa_authored','ai_generated','user_authored'));
ALTER TABLE public.question_bank DROP CONSTRAINT question_bank_owner_chk;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_owner_chk CHECK(user_id IS NOT NULL OR(visibility='public' AND origin IN('official_exam','licensed_dataset','remoa_authored')));
ALTER TABLE public.question_bank DROP CONSTRAINT question_bank_validation_kind_chk;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_validation_kind_chk CHECK(validation_kind IN('medical_review','remoa_institutional','remoa_curation'));
ALTER TABLE public.question_editorial_reviews DROP CONSTRAINT question_editorial_kind_chk;
ALTER TABLE public.question_editorial_reviews ADD CONSTRAINT question_editorial_kind_chk CHECK(kind IN('medical_review','remoa_institutional','remoa_curation'));
-- Existing question_editorial_identity_chk keeps CRM mandatory for medical and null/approved for institutional branches.
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_health_profession_chk CHECK(profession_code IS NULL OR profession_code IN('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy'));
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_health_language_chk CHECK(language_tag IS NULL OR language_tag IN('pt','pt-BR','pt-PT'));
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_explanation_status_chk CHECK(explanation_status IS NULL OR explanation_status IN('absent','source_provided','remoa_curated','medical_reviewed'));
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_curation_personal_data_chk CHECK(curation_personal_data_status IS NULL OR curation_personal_data_status IN('unassessed','not_detected','detected'));
ALTER TABLE public.question_editorial_reviews ADD CONSTRAINT question_reviews_curation_personal_data_chk CHECK((kind<>'remoa_curation' AND curation_personal_data_status IS NULL) OR(kind='remoa_curation' AND curation_personal_data_status='not_detected') IS TRUE);
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_curation_json_chk CHECK(curation_scope IS NULL OR(jsonb_typeof(curation_scope)='object' AND octet_length(curation_scope::text)<=16384));
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_curation_hash_chk CHECK((curation_scope_hash IS NULL OR curation_scope_hash~'^[a-f0-9]{64}$') AND(curation_reviewed_scope_hash IS NULL OR curation_reviewed_scope_hash~'^[a-f0-9]{64}$'));
ALTER TABLE public.question_editorial_reviews ADD CONSTRAINT question_reviews_curation_snapshot_chk CHECK((kind<>'remoa_curation' AND curation_scope_hash IS NULL AND curation_scope_snapshot IS NULL AND source_revision_id IS NULL) OR(kind='remoa_curation' AND curation_scope_hash~'^[a-f0-9]{64}$' AND source_revision_id IS NOT NULL AND jsonb_typeof(curation_scope_snapshot)='object' AND octet_length(curation_scope_snapshot::text)<=16384) IS TRUE);

CREATE FUNCTION public.f33_curation_scope_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path='' AS $$
 SELECT encode(extensions.digest(convert_to(value::text,'UTF8'),'sha256'),'hex')
$$;

CREATE FUNCTION public.f33_health_metadata_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE doc jsonb; lineage_ok boolean;
BEGIN
 IF TG_TABLE_NAME='question_source_revisions' THEN
  IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'verified_source_revision_immutable';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' AND
   ((NEW.id,NEW.source_id,NEW.revision,NEW.revision_label,NEW.manifest_sha256,NEW.documents,NEW.license,NEW.attribution,NEW.verified_at,NEW.created_at)
    IS DISTINCT FROM(OLD.id,OLD.source_id,OLD.revision,OLD.revision_label,OLD.manifest_sha256,OLD.documents,OLD.license,OLD.attribution,OLD.verified_at,OLD.created_at)
    OR(NEW.actor_id IS DISTINCT FROM OLD.actor_id AND NEW.actor_id IS NOT NULL)
    OR NEW.status NOT IN(OLD.status,'withdrawn')) THEN RAISE EXCEPTION 'verified_source_revision_immutable';END IF;
  IF TG_OP='UPDATE' AND NEW.status='withdrawn' AND OLD.status<>'withdrawn' AND EXISTS(SELECT 1 FROM public.question_bank q WHERE q.source_revision_id=OLD.id AND q.catalog_status='published') THEN RAISE EXCEPTION 'withdraw_published_questions_first';END IF;
  IF(jsonb_array_length(NEW.documents) BETWEEN 1 AND 200) IS NOT TRUE OR
   (SELECT count(DISTINCT d->>'documentId') FROM jsonb_array_elements(NEW.documents)d)<>jsonb_array_length(NEW.documents)
   THEN RAISE EXCEPTION 'invalid_source_documents';END IF;
  -- Revision verification vs document update: hold document SHARE locks, sorted by UUID,
  -- then recheck hashes below. Document guards read revisions without locking them;
  -- they never reverse this order by acquiring a revision lock after a document lock.
  PERFORM d.id FROM public.question_documents d
   WHERE d.id IN(SELECT (item->>'documentId')::uuid FROM jsonb_array_elements(NEW.documents)item)
   ORDER BY d.id FOR SHARE;
  FOR doc IN SELECT * FROM jsonb_array_elements(NEW.documents) LOOP
   IF NOT EXISTS(SELECT 1 FROM public.question_documents d WHERE d.id=(doc->>'documentId')::uuid AND d.source_id=NEW.source_id AND d.sha256=doc->>'sha256') THEN RAISE EXCEPTION 'source_document_mismatch';END IF;
  END LOOP;
  IF(NEW.license->>'scope'='licensed_external' AND NEW.license->>'identifier' IS NOT NULL AND NEW.license->>'evidenceSha256'~'^[a-f0-9]{64}$' AND NEW.license->>'url'~'^https://' AND NEW.attribution->>'url'~'^https://' AND length(btrim(NEW.attribution->>'publisher')) BETWEEN 1 AND 300 AND length(btrim(NEW.attribution->>'text')) BETWEEN 1 AND 4000) IS NOT TRUE THEN RAISE EXCEPTION 'invalid_license_attribution';END IF;
  IF EXISTS(SELECT 1 FROM public.question_sources s WHERE s.id=NEW.source_id AND s.rights_scope='remoa_owned') THEN RAISE EXCEPTION 'external_source_cannot_be_remoa_owned';END IF;
 ELSE
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' AND
   ((NEW.id,NEW.profession_code,NEW.kind,NEW.parent_id,NEW.code,NEW.label,NEW.revision,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.profession_code,OLD.kind,OLD.parent_id,OLD.code,OLD.label,OLD.revision,OLD.created_at) OR NEW.status NOT IN(OLD.status,'withdrawn')) THEN RAISE EXCEPTION 'reviewed_taxonomy_immutable';END IF;
  IF TG_OP='UPDATE' AND NEW.status='withdrawn' AND OLD.status<>'withdrawn' AND EXISTS(
    WITH RECURSIVE children AS(SELECT OLD.id id UNION ALL SELECT t.id FROM public.health_taxonomy t JOIN children c ON t.parent_id=c.id)
    SELECT 1 FROM public.question_bank q WHERE q.catalog_status='published' AND(q.health_topic_id IN(SELECT id FROM children) OR q.health_area_id IN(SELECT id FROM children))) THEN RAISE EXCEPTION 'withdraw_published_questions_first';END IF;
  SELECT EXISTS(WITH RECURSIVE ancestors AS(
   SELECT NEW.id id,NEW.parent_id parent_id,NEW.profession_code profession_code,ARRAY[NEW.id]path,0 depth,false cycle
   UNION ALL SELECT p.id,p.parent_id,p.profession_code,a.path||p.id,a.depth+1,p.id=ANY(a.path) FROM public.health_taxonomy p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<10 AND NOT a.cycle)
   SELECT 1 FROM ancestors WHERE NOT EXISTS(SELECT 1 FROM ancestors bad WHERE bad.cycle OR bad.profession_code<>NEW.profession_code OR(bad.depth=10 AND bad.parent_id IS NOT NULL))) INTO lineage_ok;
  IF lineage_ok IS NOT TRUE THEN RAISE EXCEPTION 'invalid_health_taxonomy_lineage';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER f33_health_taxonomy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.health_taxonomy FOR EACH ROW EXECUTE FUNCTION public.f33_health_metadata_guard();
CREATE TRIGGER f33_source_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_source_revisions FOR EACH ROW EXECUTE FUNCTION public.f33_health_metadata_guard();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.health_taxonomy FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.question_source_revisions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- P1 correction: verified/withdrawn source evidence and signed historical scopes must not
-- be rebound through mutable base documents/papers. Legacy documents without these refs remain editable.
CREATE FUNCTION public.f33_curation_document_referenced(document_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.question_source_revisions r
  WHERE r.status IN('verified','withdrawn') AND r.documents @> jsonb_build_array(jsonb_build_object('documentId',document_id::text)))
 OR EXISTS(SELECT 1 FROM public.question_editorial_reviews v WHERE v.kind='remoa_curation' AND
  (v.curation_scope_snapshot#>>'{keyEvidence,answerKeyDocumentId}'=document_id::text OR
   v.curation_scope_snapshot#>>'{keyEvidence,datasetDocumentId}'=document_id::text))
$$;
CREATE FUNCTION public.f33_curation_exam_referenced(p public.exam_papers) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
 SELECT public.f33_curation_document_referenced(p.document_id)
 OR public.f33_curation_document_referenced(p.answer_key_document_id)
 OR EXISTS(SELECT 1 FROM public.question_editorial_reviews v WHERE v.kind='remoa_curation'
  AND v.curation_scope_snapshot#>>'{keyEvidence,kind}'='official_final'
  AND v.curation_scope_snapshot#>>'{keyEvidence,examId}'=p.id::text)
$$;
CREATE FUNCTION public.f33_curation_proof_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='question_documents' THEN
  IF NOT public.f33_curation_document_referenced(OLD.id) THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'curation_document_immutable_create_revision';END IF;
  IF(NEW.id,NEW.source_id,NEW.kind,NEW.object_key,NEW.sha256,NEW.bytes,NEW.pages,NEW.mime,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.source_id,OLD.kind,OLD.object_key,OLD.sha256,OLD.bytes,OLD.pages,OLD.mime,OLD.created_at)
   OR(NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'curation_document_immutable_create_revision';END IF;
 ELSE
  IF NOT public.f33_curation_exam_referenced(OLD) THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'curation_exam_immutable_create_revision';END IF;
  IF(NEW.id,NEW.source_id,NEW.document_id,NEW.answer_key_document_id,NEW.name,NEW.institution,NEW.year,NEW.edition,NEW.booklet,NEW.version,NEW.key_final,NEW.key_revision,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.source_id,OLD.document_id,OLD.answer_key_document_id,OLD.name,OLD.institution,OLD.year,OLD.edition,OLD.booklet,OLD.version,OLD.key_final,OLD.key_revision,OLD.created_at)
  THEN RAISE EXCEPTION 'curation_exam_immutable_create_revision';END IF;
  -- Withdrawal/status and suggested duration remain mutable; they do not rewrite the proof.
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER f33_curation_document_immutable BEFORE UPDATE OR DELETE ON public.question_documents
 FOR EACH ROW EXECUTE FUNCTION public.f33_curation_proof_immutable();
CREATE TRIGGER f33_curation_exam_immutable BEFORE UPDATE OR DELETE ON public.exam_papers
 FOR EACH ROW EXECUTE FUNCTION public.f33_curation_proof_immutable();
-- Candidates only, no EXPLAIN/performance claim: support containment/history guard lookups.
CREATE INDEX question_source_revisions_documents_idx ON public.question_source_revisions USING gin(documents jsonb_path_ops)
 WHERE status IN('verified','withdrawn');
CREATE INDEX question_curation_review_key_document_idx ON public.question_editorial_reviews
 ((curation_scope_snapshot#>>'{keyEvidence,answerKeyDocumentId}')) WHERE kind='remoa_curation';
CREATE INDEX question_curation_review_dataset_document_idx ON public.question_editorial_reviews
 ((curation_scope_snapshot#>>'{keyEvidence,datasetDocumentId}')) WHERE kind='remoa_curation';
CREATE INDEX question_curation_review_exam_idx ON public.question_editorial_reviews
 ((curation_scope_snapshot#>>'{keyEvidence,examId}')) WHERE kind='remoa_curation';

CREATE FUNCTION public.f33_curation_validate_question(q public.question_bank,previous public.question_bank) RETURNS public.question_bank LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.question_source_revisions%ROWTYPE; e jsonb; c jsonb; total integer; valid integer; distinct_keys integer; taxonomy_ok boolean;
BEGIN
 q.canonical_id:=coalesce(q.canonical_id,(SELECT canonical_id FROM public.question_bank WHERE id=q.supersedes_id),q.id);
 IF(q.user_id IS NULL AND q.visibility='public' AND q.origin IN('official_exam','licensed_dataset') AND q.type='objective') IS NOT TRUE THEN RAISE EXCEPTION 'curation_scope_requires_external_institutional';END IF;
 SELECT count(*),count(DISTINCT a->>'key'),count(*)FILTER(WHERE a->>'key' IN('A','B','C','D','E','F','G','H','I','J') AND jsonb_typeof(a->'text')='string' AND length(a->>'text')>0) INTO total,distinct_keys,valid FROM jsonb_array_elements(q.alternatives)a;
 IF total NOT BETWEEN 2 AND 10 OR total<>distinct_keys OR total<>valid THEN RAISE EXCEPTION 'invalid_alternatives';END IF;
 IF q.correct_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.alternatives)a WHERE a->>'key'=q.correct_key) THEN RAISE EXCEPTION 'key_not_in_alternatives';END IF;
 IF previous.id IS NOT NULL AND previous.published_at IS NOT NULL AND
  (q.stem,q.alternatives,q.correct_key,q.expected_answer,q.explanation,q.key_points,q.distractor_notes,q.assets,q.type,q.difficulty,q.evidences,q.enamed_area_id,q.enamed_domain_id,q.enamed_competency_id,q.enamed_topic_id,q.origin,q.source_id,q.content_hash,q.reviewed_hash,q.reviewer_name,q.reviewer_crm,q.validation_kind,q.reference_date,q.version,q.canonical_id,q.supersedes_id)
  IS DISTINCT FROM(previous.stem,previous.alternatives,previous.correct_key,previous.expected_answer,previous.explanation,previous.key_points,previous.distractor_notes,previous.assets,previous.type,previous.difficulty,previous.evidences,previous.enamed_area_id,previous.enamed_domain_id,previous.enamed_competency_id,previous.enamed_topic_id,previous.origin,previous.source_id,previous.content_hash,previous.reviewed_hash,previous.reviewer_name,previous.reviewer_crm,previous.validation_kind,previous.reference_date,previous.version,previous.canonical_id,previous.supersedes_id) THEN RAISE EXCEPTION 'published_content_immutable_create_version';END IF;
 IF q.catalog_status<>'published' THEN RETURN q;END IF;
 SELECT * INTO r FROM public.question_source_revisions WHERE id=q.source_revision_id;
 IF(r.id IS NOT NULL AND r.source_id=q.source_id AND r.status='verified' AND r.license->>'verified'='true' AND r.license->>'scope'='licensed_external') IS NOT TRUE THEN RAISE EXCEPTION 'verified_external_revision_required';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.question_sources s WHERE s.id=q.source_id AND s.rights_status='authorized' AND s.rights_scope IS DISTINCT FROM 'remoa_owned' AND(s.rights_expires_at IS NULL OR s.rights_expires_at>now())) THEN RAISE EXCEPTION 'source_rights_required';END IF;
 IF q.curation_personal_data_status IS DISTINCT FROM 'not_detected' THEN RAISE EXCEPTION 'external_personal_data_unresolved';END IF;
 IF EXISTS(SELECT 1 FROM public.question_import_candidates c WHERE c.question_id=q.id AND(c.state NOT IN('accepted','duplicate') OR cardinality(c.issues)>0)) OR EXISTS(SELECT 1 FROM public.question_import_contexts ctx JOIN public.question_import_candidates c ON c.import_id=ctx.import_id WHERE c.question_id=q.id AND ctx.status='unresolved') THEN RAISE EXCEPTION 'staging_context_or_image_unresolved';END IF;
 IF(q.integrity_confirmed AND q.profession_verified AND q.language_verified AND q.health_taxonomy_verified AND q.language_tag IN('pt','pt-BR','pt-PT') AND q.profession_code IN('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy')) IS NOT TRUE THEN RAISE EXCEPTION 'curation_classification_integrity_required';END IF;
 IF cardinality(q.profession_tags)>11 OR q.profession_tags IS NULL OR array_position(q.profession_tags,q.profession_code) IS NOT NULL OR
  (SELECT count(DISTINCT tag)FROM unnest(q.profession_tags)tag)<>cardinality(q.profession_tags) OR EXISTS(SELECT 1 FROM unnest(q.profession_tags)tag WHERE tag NOT IN('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy') OR tag IS NULL) THEN RAISE EXCEPTION 'invalid_profession_tags';END IF;
 c:=q.curation_scope->'classification';e:=q.curation_scope->'keyEvidence';
 IF(q.curation_scope_hash=public.f33_curation_scope_hash(q.curation_scope) AND q.curation_scope_hash=q.curation_reviewed_scope_hash AND q.curation_scope->>'contentHash'=q.content_hash AND q.curation_scope->>'sourceId'=q.source_id::text AND q.curation_scope->>'sourceRevisionId'=r.id::text AND q.curation_scope->>'origin'=q.origin AND q.curation_scope->>'integrityConfirmed'='true' AND q.curation_scope->>'sourceKeyValidated'='true' AND c->>'professionCode'=q.profession_code AND c->>'languageTag'=q.language_tag AND c->>'professionVerified'='true' AND c->>'languageVerified'='true' AND c->>'taxonomyVerified'='true' AND c->'professionTags'=to_jsonb(q.profession_tags) AND e->>'sourceId'=q.source_id::text AND e->>'sourceRevisionId'=r.id::text AND e->>'mappingValidated'='true') IS NOT TRUE THEN RAISE EXCEPTION 'curation_signed_scope_mismatch';END IF;
 IF c->'taxonomy'->>'system'='enamed' THEN
  IF q.profession_code<>'medicine' OR q.health_area_id IS NOT NULL OR q.health_topic_id IS NOT NULL OR(c->'taxonomy'->>'areaId'=q.enamed_area_id::text AND c->'taxonomy'->>'topicId'=q.enamed_topic_id::text) IS NOT TRUE THEN RAISE EXCEPTION 'enamed_requires_medicine';END IF;
  SELECT EXISTS(WITH RECURSIVE lineage AS(SELECT t.id,t.parent_id,t.area,ARRAY[t.id]path,0 depth,false cycle FROM public.enamed_taxonomy t WHERE t.id=q.enamed_topic_id AND t.kind='topic'
   UNION ALL SELECT p.id,p.parent_id,p.area,l.path||p.id,l.depth+1,p.id=ANY(l.path)FROM public.enamed_taxonomy p JOIN lineage l ON p.id=l.parent_id WHERE l.depth<10 AND NOT l.cycle)
   SELECT 1 FROM lineage l JOIN public.enamed_taxonomy a ON a.id=q.enamed_area_id AND a.kind='area' WHERE l.id=a.id AND NOT EXISTS(SELECT 1 FROM lineage bad WHERE bad.area<>a.area OR bad.cycle OR(bad.depth=10 AND bad.parent_id IS NOT NULL))) INTO taxonomy_ok;
 ELSE
  IF(c->'taxonomy'->>'system'='health' AND c->'taxonomy'->>'areaId'=q.health_area_id::text AND c->'taxonomy'->>'topicId'=q.health_topic_id::text AND q.enamed_area_id IS NULL AND q.enamed_topic_id IS NULL) IS NOT TRUE THEN RAISE EXCEPTION 'health_taxonomy_binding_required';END IF;
  SELECT EXISTS(WITH RECURSIVE lineage AS(SELECT t.*,ARRAY[t.id]path,0 depth,false cycle FROM public.health_taxonomy t WHERE t.id=q.health_topic_id AND t.kind IN('topic','general') AND t.kind=c->'taxonomy'->>'topicKind' AND t.revision=(c->'taxonomy'->>'taxonomyRevision')::integer
   UNION ALL SELECT p.*,l.path||p.id,l.depth+1,p.id=ANY(l.path)FROM public.health_taxonomy p JOIN lineage l ON p.id=l.parent_id WHERE l.depth<10 AND NOT l.cycle)
   SELECT 1 FROM lineage l WHERE l.id=q.health_area_id AND l.kind='area' AND NOT EXISTS(SELECT 1 FROM lineage bad WHERE bad.profession_code<>q.profession_code OR bad.status<>'reviewed' OR bad.cycle OR(bad.depth=10 AND bad.parent_id IS NOT NULL))) INTO taxonomy_ok;
 END IF;
 IF taxonomy_ok IS NOT TRUE THEN RAISE EXCEPTION 'invalid_public_question_taxonomy';END IF;
 IF q.origin='official_exam' THEN
  IF(e->>'kind'='official_final' AND e->>'finalityVerified'='true' AND q.key_final AND(e->>'annulled')::boolean=(q.availability='annulled')) IS NOT TRUE THEN RAISE EXCEPTION 'official_final_key_required';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_papers p JOIN public.question_documents d ON d.id=p.answer_key_document_id WHERE p.id=(e->>'examId')::uuid AND p.source_id=q.source_id AND p.edition=e->>'edition' AND p.booklet=e->>'booklet' AND d.id=(e->>'answerKeyDocumentId')::uuid AND d.source_id=q.source_id AND d.kind='answer_key' AND d.sha256=e->>'answerKeySha256' AND(e->>'page')::integer BETWEEN 1 AND d.pages AND(e->>'originalNumber')::integer BETWEEN 1 AND 999 AND r.documents @> jsonb_build_array(jsonb_build_object('documentId',d.id::text,'sha256',d.sha256))) THEN RAISE EXCEPTION 'official_key_document_mismatch';END IF;
 ELSE
  IF(e->>'kind'='dataset_label' AND e->>'labelVerified'='true' AND q.availability='active' AND q.correct_key IS NOT NULL AND q.key_final=false AND NOT EXISTS(SELECT 1 FROM unnest(string_to_array(e->>'answerField','.'))part WHERE part IN('__proto__','prototype','constructor')) AND length(btrim(e->>'recordId')) BETWEEN 1 AND 200 AND e->>'answerField'~'^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$') IS NOT TRUE THEN RAISE EXCEPTION 'confirmed_dataset_label_required';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.question_documents d WHERE d.id=(e->>'datasetDocumentId')::uuid AND d.source_id=q.source_id AND d.sha256=e->>'datasetFileSha256' AND d.mime IN('application/json','application/x-ndjson','text/csv') AND r.documents @> jsonb_build_array(jsonb_build_object('documentId',d.id::text,'sha256',d.sha256))) THEN RAISE EXCEPTION 'dataset_document_mismatch';END IF;
 END IF;
 IF(q.explanation_status=q.curation_scope->>'explanationStatus') IS NOT TRUE THEN RAISE EXCEPTION 'explanation_state_invalid';END IF;
 IF q.explanation_status='absent' THEN
  IF q.explanation IS NOT NULL OR q.explanation_review_id IS NOT NULL THEN RAISE EXCEPTION 'absent_explanation_must_be_null';END IF;
 ELSE
  IF nullif(btrim(q.explanation),'') IS NULL THEN RAISE EXCEPTION 'explanation_state_invalid';END IF;
  IF q.explanation_status='medical_reviewed' THEN
   IF NOT EXISTS(SELECT 1 FROM public.question_editorial_reviews v WHERE v.id=q.explanation_review_id AND v.question_id=q.id AND v.kind='medical_review' AND v.decision='approved' AND v.content_hash=q.content_hash) OR q.curation_scope->>'explanationReviewId' IS DISTINCT FROM q.explanation_review_id::text THEN RAISE EXCEPTION 'medical_explanation_review_required';END IF;
  ELSIF q.explanation_review_id IS NOT NULL THEN RAISE EXCEPTION 'unexpected_explanation_review';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.question_editorial_reviews v WHERE v.question_id=q.id AND v.kind='remoa_curation' AND v.decision='approved' AND v.content_hash=q.content_hash AND v.curation_scope_hash=q.curation_scope_hash AND v.curation_scope_snapshot=q.curation_scope AND v.source_revision_id=r.id AND v.curation_personal_data_status=q.curation_personal_data_status AND v.reviewer_crm IS NULL AND v.reviewer_name=q.reviewer_name AND v.reference_date=q.reference_date AND v.id=(SELECT last.id FROM public.question_editorial_reviews last WHERE last.question_id=q.id AND last.content_hash=q.content_hash ORDER BY last.reviewed_at DESC,last.id DESC LIMIT 1)) THEN RAISE EXCEPTION 'curation_review_required';END IF;
 RETURN q;
END $$;

CREATE FUNCTION public.f33_curation_signature_guard(v public.question_editorial_reviews) RETURNS public.question_editorial_reviews LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q public.question_bank%ROWTYPE;
BEGIN
 IF(v.kind='remoa_curation' AND v.decision='approved' AND v.reviewer_crm IS NULL AND length(btrim(v.reason))>=8 AND nullif(btrim(v.reviewer_name),'') IS NOT NULL AND public.f33_calendar_date(v.reference_date)) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=v.user_id AND p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL) THEN RAISE EXCEPTION 'active_admin_curator_required';END IF;
 SELECT * INTO q FROM public.question_bank WHERE id=v.question_id;
 IF(q.id IS NOT NULL AND q.user_id IS NULL AND q.visibility='public' AND q.origin IN('official_exam','licensed_dataset') AND v.content_hash=q.content_hash AND v.source_revision_id=q.source_revision_id AND v.curation_scope_snapshot=q.curation_scope AND v.curation_scope_hash=public.f33_curation_scope_hash(q.curation_scope) AND v.curation_personal_data_status=q.curation_personal_data_status AND q.curation_personal_data_status='not_detected' AND EXISTS(SELECT 1 FROM public.question_source_revisions sr JOIN public.question_sources s ON s.id=sr.source_id WHERE sr.id=q.source_revision_id AND sr.source_id=q.source_id AND sr.status='verified' AND s.rights_scope IS DISTINCT FROM 'remoa_owned' AND s.rights_status='authorized' AND(s.rights_expires_at IS NULL OR s.rights_expires_at>now()))) IS NOT TRUE THEN RAISE EXCEPTION 'curation_signed_scope_mismatch';END IF;
 RETURN v;
END $$;

-- Attach new branches without rewriting the medical/D1819 function bodies. Abort on an unexpected baseline.
DO $branch$
DECLARE original text; position integer;
BEGIN
 original:=pg_get_functiondef('public.f33_validate_question()'::regprocedure);
 IF strpos(original,'NEW.validation_kind=''remoa_institutional''')=0 OR strpos(original,'f33_curation_validate_question')>0 THEN RAISE EXCEPTION 'unexpected_question_guard_baseline';END IF;
 position:=strpos(original,E'BEGIN\n');IF position=0 THEN RAISE EXCEPTION 'unexpected_guard_body';END IF;
 original:=overlay(original placing E'BEGIN\n IF NEW.validation_kind=''remoa_curation'' THEN\n  IF TG_OP=''UPDATE'' THEN NEW:=public.f33_curation_validate_question(NEW,OLD); ELSE NEW:=public.f33_curation_validate_question(NEW,NULL);END IF;\n  RETURN NEW;\n END IF;\n' from position for 6);
 EXECUTE original;
 original:=pg_get_functiondef('public.f33_validate_signature()'::regprocedure);
 IF strpos(original,'NEW.kind=''remoa_institutional''')=0 OR strpos(original,'f33_curation_signature_guard')>0 THEN RAISE EXCEPTION 'unexpected_signature_guard_baseline';END IF;
 position:=strpos(original,E'BEGIN\n');IF position=0 THEN RAISE EXCEPTION 'unexpected_guard_body';END IF;
 original:=overlay(original placing E'BEGIN\n IF TG_OP=''INSERT'' AND NEW.kind=''remoa_curation'' THEN RETURN public.f33_curation_signature_guard(NEW);END IF;\n' from position for 6);
 EXECUTE original;
END $branch$;

CREATE FUNCTION public.f33_curation_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='question_bank' THEN
  IF(OLD.published_at IS NOT NULL OR OLD.catalog_status='published') AND
   (NEW.profession_code,NEW.profession_tags,NEW.profession_verified,NEW.language_tag,NEW.language_verified,NEW.health_area_id,NEW.health_topic_id,NEW.health_taxonomy_verified,NEW.source_revision_id,NEW.explanation_status,NEW.explanation_review_id,NEW.curation_scope,NEW.curation_scope_hash,NEW.curation_reviewed_scope_hash,NEW.curation_personal_data_status)
   IS DISTINCT FROM(OLD.profession_code,OLD.profession_tags,OLD.profession_verified,OLD.language_tag,OLD.language_verified,OLD.health_area_id,OLD.health_topic_id,OLD.health_taxonomy_verified,OLD.source_revision_id,OLD.explanation_status,OLD.explanation_review_id,OLD.curation_scope,OLD.curation_scope_hash,OLD.curation_reviewed_scope_hash,OLD.curation_personal_data_status) THEN RAISE EXCEPTION 'published_curation_scope_immutable_create_version';END IF;
 ELSE
  IF(NEW.source_revision_id,NEW.curation_scope_hash,NEW.curation_scope_snapshot,NEW.curation_personal_data_status) IS DISTINCT FROM(OLD.source_revision_id,OLD.curation_scope_hash,OLD.curation_scope_snapshot,OLD.curation_personal_data_status) THEN RAISE EXCEPTION 'curation_signature_immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER f33_curation_snapshot_immutable BEFORE UPDATE ON public.question_bank FOR EACH ROW EXECUTE FUNCTION public.f33_curation_snapshot_immutable();
CREATE TRIGGER f33_curation_review_immutable BEFORE UPDATE ON public.question_editorial_reviews FOR EACH ROW EXECUTE FUNCTION public.f33_curation_snapshot_immutable();

ALTER TABLE public.question_bank DROP CONSTRAINT question_bank_publish_chk;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_publish_chk CHECK (
"question_bank"."catalog_status" <> 'published' or ("question_bank"."visibility" = 'public' and "question_bank"."rights_status" = 'authorized' and "question_bank"."status" = 'approved' and "question_bank"."enamed_area_id" is not null and "question_bank"."enamed_topic_id" is not null and "question_bank"."content_hash" is not null and "question_bank"."reviewed_hash" is not null and "question_bank"."reviewed_hash" = "question_bank"."content_hash" and nullif(btrim("question_bank"."reviewer_name"),'') is not null and "question_bank"."reference_date" is not null and (("question_bank"."validation_kind" = 'medical_review' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and nullif(btrim("question_bank"."reviewer_crm"),'') is not null) or ("question_bank"."validation_kind" = 'remoa_institutional' and "question_bank"."user_id" is null and "question_bank"."origin" = 'remoa_authored' and "question_bank"."reviewer_crm" is null and "question_bank"."correct_key" is not null)))
 OR (catalog_status='published' AND validation_kind='remoa_curation' AND user_id IS NULL AND visibility='public' AND origin IN('official_exam','licensed_dataset') AND status='approved' AND rights_status='authorized' AND integrity_confirmed AND profession_verified AND language_verified AND health_taxonomy_verified AND curation_personal_data_status='not_detected' AND profession_code IS NOT NULL AND language_tag IS NOT NULL AND source_revision_id IS NOT NULL AND content_hash IS NOT NULL AND reviewed_hash=content_hash AND curation_scope_hash IS NOT NULL AND curation_reviewed_scope_hash=curation_scope_hash AND reviewer_crm IS NULL AND nullif(btrim(reviewer_name),'') IS NOT NULL AND reference_date IS NOT NULL) IS TRUE
);

ALTER TABLE public.health_taxonomy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_source_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.health_taxonomy,public.question_source_revisions FROM PUBLIC,anon,authenticated;
CREATE POLICY health_taxonomy_reviewed ON public.health_taxonomy FOR SELECT TO authenticated USING(status='reviewed');
GRANT SELECT(id,profession_code,kind,parent_id,code,label,revision,status) ON public.health_taxonomy TO authenticated;
-- No SELECT on source revisions, scope JSON, evidence snapshots or reference columns for students.
GRANT SELECT(profession_code,profession_tags,language_tag,health_area_id,health_topic_id,explanation_status) ON public.question_bank TO authenticated;
DROP POLICY question_bank_select ON public.question_bank;
CREATE POLICY question_bank_select ON public.question_bank FOR SELECT TO authenticated USING(
 (user_id=(SELECT auth.uid()) AND visibility='private') OR
 (visibility='public' AND catalog_status='published' AND rights_status='authorized' AND availability IN('active','annulled') AND
  (validation_kind<>'remoa_curation' OR(curation_scope_hash IS NOT NULL AND curation_scope_hash=curation_reviewed_scope_hash AND reviewed_hash=content_hash)IS TRUE) AND
  EXISTS(SELECT 1 FROM public.question_sources s WHERE s.id=question_bank.source_id AND s.rights_status='authorized' AND(s.rights_expires_at IS NULL OR s.rights_expires_at>now())))
);
REVOKE ALL ON FUNCTION public.f33_curation_scope_hash(jsonb),public.f33_health_metadata_guard(),public.f33_curation_validate_question(public.question_bank,public.question_bank),public.f33_curation_signature_guard(public.question_editorial_reviews),public.f33_curation_snapshot_immutable() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.f33_curation_document_referenced(uuid),public.f33_curation_exam_referenced(public.exam_papers),public.f33_curation_proof_immutable() FROM PUBLIC,anon,authenticated;
-- API uses its existing server role, never grants client INSERT/UPDATE. Service role is still trusted-server only.
GRANT ALL ON public.health_taxonomy,public.question_source_revisions TO service_role;
GRANT EXECUTE ON FUNCTION public.f33_curation_scope_hash(jsonb),public.f33_health_metadata_guard(),public.f33_curation_validate_question(public.question_bank,public.question_bank),public.f33_curation_signature_guard(public.question_editorial_reviews),public.f33_curation_snapshot_immutable() TO service_role;
GRANT EXECUTE ON FUNCTION public.f33_curation_document_referenced(uuid),public.f33_curation_exam_referenced(public.exam_papers),public.f33_curation_proof_immutable() TO service_role;
-- Do not grant correct_key, explanation, curation_scope or review snapshots to anon/authenticated.
-- Pending isolated tests: trigger dispatch/null-safety/doc mismatch/TTL/revoke/legacy signatures/deletion/RLSactualroles/locking.
