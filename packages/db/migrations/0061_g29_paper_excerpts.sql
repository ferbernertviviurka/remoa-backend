ALTER TABLE "exam_papers" ADD COLUMN "coverage_kind" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "exam_papers" ADD COLUMN "expected_question_count" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_papers_source_excerpt_uq" ON "exam_papers" USING btree ("source_id") WHERE "exam_papers"."coverage_kind"='source_excerpt';--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_coverage_kind_chk" CHECK ("exam_papers"."coverage_kind" in ('unknown','source_excerpt','complete'));--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_expected_count_chk" CHECK ("exam_papers"."expected_question_count" IS NULL OR "exam_papers"."expected_question_count">0);--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_complete_evidence_chk" CHECK ("exam_papers"."coverage_kind"<>'complete' OR "exam_papers"."expected_question_count" IS NOT NULL);
--> statement-breakpoint
-- D-1886 / CCR-173: only server-side audited indexing may derive an excerpt of the fixed signed cohort.
-- Sources/documents/occurrences stay private; this never changes a signed question or exposes an answer key.
CREATE FUNCTION public.f34_source_excerpt_paper_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE item public.question_team_items%ROWTYPE; payload jsonb; expected integer; actual integer; numbers text[]; ordered text[];
BEGIN
 IF TG_OP='DELETE' THEN IF OLD.coverage_kind='source_excerpt' THEN RAISE EXCEPTION 'source_excerpt_metadata_immutable';END IF;RETURN OLD;END IF;
 IF TG_OP='UPDATE' AND OLD.coverage_kind='source_excerpt' AND
  (NEW.id,NEW.source_id,NEW.document_id,NEW.answer_key_document_id,NEW.name,NEW.institution,NEW.year,NEW.edition,NEW.booklet,NEW.version,NEW.duration_sec,NEW.key_final,NEW.key_revision,NEW.coverage_kind,NEW.expected_question_count,NEW.created_at)
   IS DISTINCT FROM
  (OLD.id,OLD.source_id,OLD.document_id,OLD.answer_key_document_id,OLD.name,OLD.institution,OLD.year,OLD.edition,OLD.booklet,OLD.version,OLD.duration_sec,OLD.key_final,OLD.key_revision,OLD.coverage_kind,OLD.expected_question_count,OLD.created_at)
 THEN RAISE EXCEPTION 'source_excerpt_metadata_immutable';END IF;
 IF NEW.coverage_kind<>'source_excerpt' THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND NEW.status='withdrawn' THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' AND NEW.status<>'draft' THEN RAISE EXCEPTION 'source_excerpt_stage_first';END IF;
 IF TG_OP='UPDATE' AND OLD.coverage_kind<>'source_excerpt' THEN RAISE EXCEPTION 'source_excerpt_create_fresh';END IF;
 SELECT i.* INTO item FROM public.question_team_items i JOIN public.question_team_batches b ON b.id=i.batch_id
 WHERE i.source_id=NEW.source_id AND b.namespace='g29-cp21-20261019' AND b.sealed_at IS NOT NULL AND b.activated_at IS NOT NULL AND b.revoked_at IS NULL
 ORDER BY i.offline_id COLLATE "C" LIMIT 1;
 IF item.id IS NULL THEN RAISE EXCEPTION 'source_excerpt_membership_required';END IF;
 payload:=item.original_payload;
 IF NEW.expected_question_count IS NOT NULL OR NEW.duration_sec IS NOT NULL OR NEW.key_final OR NEW.key_revision IS NOT NULL
   OR NEW.year IS DISTINCT FROM (payload->>'ano')::integer OR NEW.edition IS DISTINCT FROM coalesce(payload->>'edicao','')
   OR NEW.booklet IS DISTINCT FROM coalesce(nullif(payload#>>'{fonte,tipo_caderno}',''),payload#>>'{fonte,caderno}','')
 THEN RAISE EXCEPTION 'source_excerpt_observed_metadata_required';END IF;
 IF payload#>>'{fonte,prova_sha256}' IS NOT NULL AND NEW.document_id IS NULL THEN RAISE EXCEPTION 'source_excerpt_document_required';END IF;
 IF NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.question_documents d WHERE d.id=NEW.document_id AND d.source_id=NEW.source_id AND d.kind='exam'
   AND d.sha256=payload#>>'{fonte,prova_sha256}' AND d.object_key='questions/team-publication/g29-cp21-20261019/sha256/'||d.sha256)
 THEN RAISE EXCEPTION 'source_excerpt_document_mismatch';END IF;
 IF NEW.answer_key_document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.question_documents d WHERE d.id=NEW.answer_key_document_id AND d.source_id=NEW.source_id AND d.kind='answer_key' AND d.sha256=payload#>>'{fonte,gabarito_sha256}')
 THEN RAISE EXCEPTION 'source_excerpt_key_document_mismatch';END IF;
 IF NEW.status='published' THEN
  SELECT count(*)::integer,array_agg(i.original_payload->>'numero' ORDER BY (i.original_payload->>'numero')::integer) INTO expected,numbers
  FROM public.question_team_items i JOIN public.question_bank q ON q.id=i.question_id
  WHERE i.source_id=NEW.source_id AND public.f33_team_question_visible(q.id,q.content_hash);
  SELECT count(*)::integer,array_agg(o.original_number ORDER BY o.ordinal) INTO actual,ordered FROM public.exam_question_occurrences o WHERE o.paper_id=NEW.id;
  IF expected=0 OR expected<>(SELECT count(*) FROM public.question_team_items i WHERE i.source_id=NEW.source_id) OR expected<>actual OR numbers IS DISTINCT FROM ordered
   OR NOT EXISTS(SELECT 1 FROM public.question_sources s WHERE s.id=NEW.source_id AND s.rights_status='authorized' AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now()))
  THEN RAISE EXCEPTION 'source_excerpt_index_incomplete';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_source_excerpt_paper_guard BEFORE INSERT OR UPDATE OR DELETE ON public.exam_papers FOR EACH ROW EXECUTE FUNCTION public.f34_source_excerpt_paper_guard();
--> statement-breakpoint
CREATE FUNCTION public.f34_source_excerpt_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE paper public.exam_papers%ROWTYPE;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM public.exam_papers p WHERE p.id=OLD.paper_id AND p.coverage_kind='source_excerpt') THEN RAISE EXCEPTION 'source_excerpt_occurrence_immutable';END IF;
 SELECT * INTO paper FROM public.exam_papers WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.paper_id ELSE NEW.paper_id END FOR SHARE;
 IF paper.coverage_kind IS DISTINCT FROM 'source_excerpt' THEN RETURN coalesce(NEW,OLD);END IF;
 IF TG_OP='INSERT' AND paper.status='published' AND EXISTS(SELECT 1 FROM public.exam_question_occurrences o WHERE o.id=NEW.id AND (o.paper_id,o.question_id,o.ordinal,o.original_number,o.original_keys,o.key_revision,o.annulled,o.provenance) IS NOT DISTINCT FROM (NEW.paper_id,NEW.question_id,NEW.ordinal,NEW.original_number,NEW.original_keys,NEW.key_revision,NEW.annulled,NEW.provenance)) THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR paper.status<>'draft' THEN RAISE EXCEPTION 'source_excerpt_occurrence_immutable';END IF;
 IF NEW.original_keys IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.question_team_items i JOIN public.question_bank q ON q.id=i.question_id
   WHERE i.source_id=paper.source_id AND i.question_id=NEW.question_id AND i.original_payload->>'numero'=NEW.original_number
    AND NEW.annulled=(q.availability='annulled') AND q.content_hash=i.content_hash AND q.reviewed_hash=i.content_hash)
 THEN RAISE EXCEPTION 'source_excerpt_occurrence_membership_mismatch';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_source_excerpt_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.exam_question_occurrences FOR EACH ROW EXECUTE FUNCTION public.f34_source_excerpt_occurrence_guard();
--> statement-breakpoint
CREATE FUNCTION public.f34_source_excerpt_document_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.user_id IS NULL AND (NEW.id,NEW.source_id,NEW.kind,NEW.object_key,NEW.sha256,NEW.bytes,NEW.pages,NEW.mime,NEW.created_at,NEW.updated_at) IS NOT DISTINCT FROM (OLD.id,OLD.source_id,OLD.kind,OLD.object_key,OLD.sha256,OLD.bytes,OLD.pages,OLD.mime,OLD.created_at,OLD.updated_at) THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM public.exam_papers p WHERE p.coverage_kind='source_excerpt' AND (p.document_id=OLD.id OR p.answer_key_document_id=OLD.id))
 THEN RAISE EXCEPTION 'source_excerpt_document_immutable';END IF;
 RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_source_excerpt_document_guard BEFORE UPDATE OR DELETE ON public.question_documents FOR EACH ROW EXECUTE FUNCTION public.f34_source_excerpt_document_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f34_source_excerpt_paper_guard(),public.f34_source_excerpt_occurrence_guard(),public.f34_source_excerpt_document_guard() FROM PUBLIC,anon,authenticated;
