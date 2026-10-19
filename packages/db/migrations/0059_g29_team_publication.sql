CREATE TABLE "question_team_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"corpus_hash" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"membership_hash" text NOT NULL,
	"expected_count" integer NOT NULL,
	"attestation" text NOT NULL,
	"actor_id" uuid,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "question_team_batches_namespace_unique" UNIQUE("namespace"),
	CONSTRAINT "question_team_batch_pin_chk" CHECK ("question_team_batches"."namespace"='g29-cp21-20261019' AND "question_team_batches"."corpus_hash"='0616493c0f337e4edb1a8f698cacd40dbe1466933eeba5256a65cf073d9c8d2e' AND "question_team_batches"."manifest_hash"='f3d40e71a86c071b2792e49bb09e1f3030b9aaf3ca66e94a94cba1055a0afc63' AND "question_team_batches"."membership_hash"='a6e42dd838112d7c3e74de2b58f9a6f65644b7242c5494553de4756abeba2ba8' AND "question_team_batches"."expected_count"=28188 AND "question_team_batches"."attestation"='Publique todas. Todas foram validadas pelo time da Remoa.'),
	CONSTRAINT "question_team_batch_phase_chk" CHECK (("question_team_batches"."activated_at" IS NULL OR "question_team_batches"."sealed_at" IS NOT NULL) AND ("question_team_batches"."revoked_at" IS NULL OR "question_team_batches"."activated_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "question_team_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_team_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"offline_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"source_line_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"scope_hash" text NOT NULL,
	"profession_code" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"original_payload" jsonb NOT NULL,
	CONSTRAINT "question_team_items_batch_offline_uq" UNIQUE("batch_id","offline_id"),
	CONSTRAINT "question_team_items_question_uq" UNIQUE("question_id"),
	CONSTRAINT "question_team_items_hash_chk" CHECK ("question_team_items"."payload_hash"~'^[a-f0-9]{64}$' AND "question_team_items"."source_line_hash"~'^[a-f0-9]{64}$' AND "question_team_items"."content_hash"~'^[a-f0-9]{64}$' AND "question_team_items"."scope_hash"~'^[a-f0-9]{64}$'),
	CONSTRAINT "question_team_items_flags_chk" CHECK ("question_team_items"."flags"<@ARRAY['annulled','key_conflict','image_missing','key_finality_unverified']::text[] AND cardinality("question_team_items"."flags")<=4),
	CONSTRAINT "question_team_items_payload_chk" CHECK (jsonb_typeof("question_team_items"."original_payload")='object' AND octet_length("question_team_items"."original_payload"::text)<=1048576 AND length("question_team_items"."offline_id") BETWEEN 1 AND 300),
	CONSTRAINT "question_team_items_profession_chk" CHECK ("question_team_items"."profession_code" IN ('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy'))
);
--> statement-breakpoint
ALTER TABLE "question_team_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_validation_kind_chk";--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_publish_chk";--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" DROP CONSTRAINT "question_editorial_kind_chk";--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "profession_code" text;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD COLUMN "team_scope_hash" text;--> statement-breakpoint
ALTER TABLE "question_team_batches" ADD CONSTRAINT "question_team_batches_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_team_items" ADD CONSTRAINT "question_team_items_batch_id_question_team_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."question_team_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_team_items" ADD CONSTRAINT "question_team_items_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_team_items" ADD CONSTRAINT "question_team_items_source_id_question_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."question_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_team_items_source_idx" ON "question_team_items" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_profession_chk" CHECK ("question_bank"."profession_code" IS NULL OR "question_bank"."profession_code" IN ('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_validation_kind_chk" CHECK ("question_bank"."validation_kind" in ('medical_review', 'remoa_institutional', 'remoa_team_attested'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_publish_chk" CHECK ("question_bank"."catalog_status" <> 'published' or (("question_bank"."visibility" = 'public' and "question_bank"."rights_status" = 'authorized' and "question_bank"."status" = 'approved' and "question_bank"."enamed_area_id" is not null and "question_bank"."enamed_topic_id" is not null and "question_bank"."content_hash" is not null and "question_bank"."reviewed_hash" is not null and "question_bank"."reviewed_hash" = "question_bank"."content_hash" and nullif(btrim("question_bank"."reviewer_name"),'') is not null and "question_bank"."reference_date" is not null and (("question_bank"."validation_kind" = 'medical_review' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and nullif(btrim("question_bank"."reviewer_crm"),'') is not null) or ("question_bank"."validation_kind" = 'remoa_institutional' and "question_bank"."user_id" is null and "question_bank"."origin" = 'remoa_authored' and "question_bank"."reviewer_crm" is null and "question_bank"."correct_key" is not null))) OR ("question_bank"."visibility"='public' AND "question_bank"."origin"='official_exam' AND "question_bank"."user_id" IS NULL AND "question_bank"."validation_kind"='remoa_team_attested' AND "question_bank"."rights_status"='pending' AND "question_bank"."status"='approved' AND "question_bank"."content_hash" IS NOT NULL AND "question_bank"."reviewed_hash"="question_bank"."content_hash" AND "question_bank"."reviewer_name"='Remoa' AND "question_bank"."reviewer_crm" IS NULL AND "question_bank"."reference_date"='2026-10-19' AND "question_bank"."profession_code" IS NOT NULL)) IS TRUE);--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_kind_chk" CHECK ("question_editorial_reviews"."kind" in ('medical_review','remoa_institutional','remoa_team_attested'));
--> statement-breakpoint

-- Deterministic UTF-8 JSON for the projection (no numeric floats in this format).
CREATE FUNCTION public.f33_team_json(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT CASE jsonb_typeof(v)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(e.key)::text||':'||public.f33_team_json(e.value),',' ORDER BY e.key COLLATE "C") FROM jsonb_each(v)e),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(public.f33_team_json(e.value),',' ORDER BY e.ordinality) FROM jsonb_array_elements(v)WITH ORDINALITY e),'')||']'
 ELSE v::text END
$$;
--> statement-breakpoint
CREATE FUNCTION public.f33_team_content_hash(q public.question_bank) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT encode(sha256(convert_to('{"stem":'||to_jsonb(q.stem)::text||',"alternatives":'||public.f33_team_json(coalesce(q.alternatives,'null'::jsonb))||',"correctKey":'||coalesce(to_jsonb(q.correct_key)::text,'null')||',"explanation":'||coalesce(to_jsonb(q.explanation)::text,'null')||',"areaId":'||coalesce(to_jsonb(q.enamed_area_id)::text,'null')||',"topicId":'||coalesce(to_jsonb(q.enamed_topic_id)::text,'null')||',"annulled":'||CASE WHEN q.availability='annulled' THEN 'true' ELSE 'false' END||',"assets":'||public.f33_team_json(coalesce((SELECT jsonb_agg(e.value-'url' ORDER BY e.ordinality) FROM jsonb_array_elements(q.assets)WITH ORDINALITY e),'[]'::jsonb))||'}','UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION public.f33_team_scope_hash(i public.question_team_items,q public.question_bank) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT encode(sha256(convert_to('{"namespace":"g29-cp21-20261019","itemId":'||to_jsonb(i.id)::text||',"offlineId":'||to_jsonb(i.offline_id)::text||',"payloadHash":'||to_jsonb(i.payload_hash)::text||',"sourceId":'||to_jsonb(i.source_id)::text||',"origin":"official_exam","profession":'||to_jsonb(i.profession_code)::text||',"language":"pt-BR","contentHash":'||to_jsonb(i.content_hash)::text||',"availability":'||to_jsonb(q.availability)::text||',"flags":'||public.f33_team_json(to_jsonb(i.flags))||',"rights":"pending","disclosure":1}','UTF8')),'hex')
$$;
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
  IF (NEW.id,NEW.question_id,NEW.kind,NEW.reviewer_name,NEW.reviewer_crm,NEW.content_hash,NEW.decision,NEW.reason,NEW.reference_date,NEW.reviewed_at,NEW.team_scope_hash)
   IS DISTINCT FROM (OLD.id,OLD.question_id,OLD.kind,OLD.reviewer_name,OLD.reviewer_crm,OLD.content_hash,OLD.decision,OLD.reason,OLD.reference_date,OLD.reviewed_at,OLD.team_scope_hash)
   OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'medical_signature_immutable';END IF;
  RETURN NEW;
 END IF;
 -- D-1819: Remoa institutional attestation. Active admin attributes it; founder display name, never a CRM; Remoa-owned scope only.
 IF NEW.kind='remoa_team_attested' THEN
  IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=NEW.user_id AND p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL)
    OR NEW.decision<>'approved' OR NEW.reviewer_name IS DISTINCT FROM 'Remoa' OR NEW.reviewer_crm IS NOT NULL OR NEW.reference_date IS DISTINCT FROM '2026-10-19'
    OR NEW.reason IS DISTINCT FROM 'Publique todas. Todas foram validadas pelo time da Remoa.'
    OR NOT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_team_batches b ON b.id=i.batch_id JOIN public.question_bank q ON q.id=i.question_id
      WHERE i.question_id=NEW.question_id AND i.content_hash=NEW.content_hash AND i.scope_hash=NEW.team_scope_hash
      AND q.content_hash=i.content_hash AND q.source_id=i.source_id AND q.profession_code=i.profession_code
      AND q.origin='official_exam' AND q.user_id IS NULL AND q.visibility='public' AND q.rights_status='pending' AND b.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'invalid_team_attestation';END IF;
  RETURN NEW;
 END IF;
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
       AND b.revoked_at IS NULL AND s.rights_status='pending' AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now())
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

-- Private evidence: no direct Data API visibility, even for admins. Audited server only.
REVOKE ALL ON public.question_team_batches,public.question_team_items FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
CREATE FUNCTION public.f33_team_batch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE n integer; membership text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'team_batch_immutable';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=NEW.actor_id AND p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL)
    OR NEW.sealed_at IS NOT NULL OR NEW.activated_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'active_admin_team_batch_required';END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.namespace,NEW.corpus_hash,NEW.manifest_hash,NEW.membership_hash,NEW.expected_count,NEW.attestation,NEW.declared_at)
  IS DISTINCT FROM (OLD.id,OLD.namespace,OLD.corpus_hash,OLD.manifest_hash,OLD.membership_hash,OLD.expected_count,OLD.attestation,OLD.declared_at)
  OR (NEW.actor_id IS DISTINCT FROM OLD.actor_id AND NEW.actor_id IS NOT NULL)
  OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 THEN RAISE EXCEPTION 'team_batch_immutable';END IF;
 IF ((NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL) OR (NEW.activated_at IS NOT NULL AND OLD.activated_at IS NULL)) AND NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=NEW.actor_id AND p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL) THEN RAISE EXCEPTION 'active_admin_team_batch_required';END IF;
 IF NEW.sealed_at IS NOT NULL AND OLD.sealed_at IS NULL THEN
  SELECT count(*)::integer,encode(sha256(convert_to(string_agg(i.offline_id||E'\t'||i.payload_hash||E'\n','' ORDER BY i.offline_id COLLATE "C"),'UTF8')),'hex') INTO n,membership FROM public.question_team_items i WHERE i.batch_id=NEW.id;
  IF n<>NEW.expected_count OR membership IS DISTINCT FROM NEW.membership_hash THEN RAISE EXCEPTION 'team_manifest_membership_mismatch';END IF;
 END IF;
 IF NEW.activated_at IS NOT NULL AND OLD.activated_at IS NULL THEN
  SELECT count(*)::integer INTO n FROM public.question_team_items i JOIN public.question_bank q ON q.id=i.question_id WHERE i.batch_id=NEW.id
   AND q.catalog_status='published' AND q.validation_kind='remoa_team_attested' AND q.content_hash=i.content_hash AND q.reviewed_hash=i.content_hash;
  IF NEW.sealed_at IS NULL OR n<>NEW.expected_count THEN RAISE EXCEPTION 'team_publication_incomplete';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f33_team_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_team_batches FOR EACH ROW EXECUTE FUNCTION public.f33_team_batch_guard();
--> statement-breakpoint
CREATE FUNCTION public.f33_team_item_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE b public.question_team_batches%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'team_item_immutable';END IF;
 SELECT * INTO b FROM public.question_team_batches WHERE id=NEW.batch_id FOR UPDATE;
 IF b.id IS NULL OR b.sealed_at IS NOT NULL OR b.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'team_batch_closed';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.question_bank q WHERE q.id=NEW.question_id AND q.content_hash=NEW.content_hash AND q.source_id=NEW.source_id AND q.profession_code=NEW.profession_code
  AND q.visibility='public' AND q.origin='official_exam' AND q.user_id IS NULL AND q.catalog_status<>'published' AND q.rights_status='pending' AND q.content_hash=public.f33_team_content_hash(q) AND NEW.scope_hash=public.f33_team_scope_hash(NEW,q))
 THEN RAISE EXCEPTION 'team_item_projection_mismatch';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f33_team_item_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_team_items FOR EACH ROW EXECUTE FUNCTION public.f33_team_item_guard();
--> statement-breakpoint
CREATE FUNCTION public.f33_team_question_visible(qid uuid,chash text) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_team_batches b ON b.id=i.batch_id JOIN public.question_bank q ON q.id=i.question_id JOIN public.question_sources s ON s.id=i.source_id
 WHERE i.question_id=qid AND i.content_hash=chash AND q.content_hash=i.content_hash AND q.reviewed_hash=i.content_hash AND q.source_id=i.source_id AND q.profession_code=i.profession_code
 AND q.visibility='public' AND q.catalog_status='published' AND q.status='approved' AND q.origin='official_exam' AND q.user_id IS NULL AND q.validation_kind='remoa_team_attested'
 AND q.rights_status='pending' AND s.rights_status='pending' AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now())
 AND b.sealed_at IS NOT NULL AND b.activated_at IS NOT NULL AND b.revoked_at IS NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_team_batch_guard(),public.f33_team_item_guard(),public.f33_team_question_visible(uuid,text) FROM PUBLIC,anon,authenticated;

--> statement-breakpoint
-- RLS needs only booleans; keep evidence private and never expose a privileged public RPC.
CREATE SCHEMA IF NOT EXISTS remoa_private;
--> statement-breakpoint
REVOKE ALL ON SCHEMA remoa_private FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
GRANT USAGE ON SCHEMA remoa_private TO authenticated;
--> statement-breakpoint
CREATE FUNCTION remoa_private.team_question_visible(qid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.question_bank q WHERE q.id=qid AND public.f33_team_question_visible(q.id,q.content_hash))
$$;
--> statement-breakpoint
CREATE FUNCTION remoa_private.team_source_visible(sid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_bank q ON q.id=i.question_id WHERE i.source_id=sid AND public.f33_team_question_visible(q.id,q.content_hash))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION remoa_private.team_question_visible(uuid),remoa_private.team_source_visible(uuid) FROM PUBLIC,anon;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION remoa_private.team_question_visible(uuid),remoa_private.team_source_visible(uuid) TO authenticated;
--> statement-breakpoint
CREATE POLICY question_team_signed_select ON public.question_bank FOR SELECT TO authenticated USING (remoa_private.team_question_visible(id));
--> statement-breakpoint
CREATE POLICY question_team_source_signed_select ON public.question_sources FOR SELECT TO authenticated USING (remoa_private.team_source_visible(id));
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_team_json(jsonb),public.f33_team_content_hash(public.question_bank),public.f33_team_scope_hash(public.question_team_items,public.question_bank) FROM PUBLIC,anon,authenticated;
