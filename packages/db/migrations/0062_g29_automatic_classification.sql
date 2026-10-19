CREATE TABLE "question_classification_bindings" (
	"run_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"course_code" text NOT NULL,
	"area_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "question_classification_bindings_run_id_question_id_pk" PRIMARY KEY("run_id","question_id"),
	CONSTRAINT "question_classification_binding_question_uq" UNIQUE("question_id"),
	CONSTRAINT "question_classification_binding_hash_chk" CHECK ("question_classification_bindings"."content_hash"~'^[a-f0-9]{64}$' AND "question_classification_bindings"."payload_hash"~'^[a-f0-9]{64}$'),
	CONSTRAINT "question_classification_binding_evidence_chk" CHECK (jsonb_typeof("question_classification_bindings"."evidence")='object' AND jsonb_typeof("question_classification_bindings"."evidence"->'signals')='array' AND jsonb_array_length("question_classification_bindings"."evidence"->'signals') BETWEEN 2 AND 8 AND length("question_classification_bindings"."evidence"->>'ruleId') BETWEEN 1 AND 100 AND octet_length("question_classification_bindings"."evidence"::text)<=8192)
);
--> statement-breakpoint
ALTER TABLE "question_classification_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_classification_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"course_code" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "question_classification_nodes_scope_uq" UNIQUE("id","run_id","course_code"),
	CONSTRAINT "question_classification_nodes_code_uq" UNIQUE("run_id","course_code","kind","code"),
	CONSTRAINT "question_classification_nodes_course_chk" CHECK ("question_classification_nodes"."course_code" IN ('medicine','psychology','dentistry','nursing','physiotherapy','pharmacy','biomedicine','nutrition','speech_therapy','physical_education','veterinary_medicine','occupational_therapy')),
	CONSTRAINT "question_classification_nodes_kind_chk" CHECK ("question_classification_nodes"."kind" IN ('area','topic') AND ("question_classification_nodes"."kind"='area')=("question_classification_nodes"."parent_id" IS NULL) AND "question_classification_nodes"."id" IS DISTINCT FROM "question_classification_nodes"."parent_id"),
	CONSTRAINT "question_classification_nodes_labels_chk" CHECK ("question_classification_nodes"."code"~'^[a-z0-9.-]{1,180}$' AND length(btrim("question_classification_nodes"."label")) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "question_classification_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_classification_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"queue_hash" text NOT NULL,
	"rule_hash" text NOT NULL,
	"rule_version" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"corpus_hash" text NOT NULL,
	"membership_hash" text NOT NULL,
	"expected_count" integer NOT NULL,
	"expected_nodes" integer NOT NULL,
	"classification_kind" text DEFAULT 'automatic_unreviewed' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "question_classification_runs_namespace_unique" UNIQUE("namespace"),
	CONSTRAINT "question_classification_run_pin_chk" CHECK ("question_classification_runs"."id"='6ca13d43-da39-5ff0-a03f-075ea7eb2501'::uuid AND "question_classification_runs"."namespace"='g29-auto-classification-v1' AND "question_classification_runs"."queue_hash"='fddc09e994200c8809363ccb9fb74fdcc17b7ca11cd7715f05ba9e7e2ad40f3c' AND "question_classification_runs"."rule_hash"='2a547fc806d7c23259a8231e29f58b6011aca4e7ef9494a5cd99b5092f44b778' AND "question_classification_runs"."rule_version"='remoa-team-classification-rules-1' AND "question_classification_runs"."bundle_hash"='6e3b517ea4b2b21fcc70cca5876d0e57c1492f9609946661c771b233d8a4272f' AND "question_classification_runs"."corpus_hash"='0616493c0f337e4edb1a8f698cacd40dbe1466933eeba5256a65cf073d9c8d2e' AND "question_classification_runs"."membership_hash"='a6e42dd838112d7c3e74de2b58f9a6f65644b7242c5494553de4756abeba2ba8' AND "question_classification_runs"."expected_count"=1209 AND "question_classification_runs"."expected_nodes"=119),
	CONSTRAINT "question_classification_run_kind_chk" CHECK ("question_classification_runs"."classification_kind"='automatic_unreviewed'),
	CONSTRAINT "question_classification_run_phase_chk" CHECK (("question_classification_runs"."status"='draft' AND "question_classification_runs"."activated_at" IS NULL AND "question_classification_runs"."withdrawn_at" IS NULL) OR ("question_classification_runs"."status"='active' AND "question_classification_runs"."activated_at" IS NOT NULL AND "question_classification_runs"."withdrawn_at" IS NULL) OR ("question_classification_runs"."status"='withdrawn' AND "question_classification_runs"."activated_at" IS NOT NULL AND "question_classification_runs"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "question_classification_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_classification_bindings" ADD CONSTRAINT "question_classification_bindings_run_id_question_classification_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."question_classification_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_bindings" ADD CONSTRAINT "question_classification_bindings_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_bindings" ADD CONSTRAINT "question_classification_binding_area_fk" FOREIGN KEY ("area_id","run_id","course_code") REFERENCES "public"."question_classification_nodes"("id","run_id","course_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_bindings" ADD CONSTRAINT "question_classification_binding_topic_fk" FOREIGN KEY ("topic_id","run_id","course_code") REFERENCES "public"."question_classification_nodes"("id","run_id","course_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_nodes" ADD CONSTRAINT "question_classification_nodes_run_id_question_classification_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."question_classification_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_nodes" ADD CONSTRAINT "question_classification_nodes_parent_fk" FOREIGN KEY ("parent_id","run_id","course_code") REFERENCES "public"."question_classification_nodes"("id","run_id","course_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_classification_runs" ADD CONSTRAINT "question_classification_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_classification_binding_filter_idx" ON "question_classification_bindings" USING btree ("run_id","course_code","area_id","topic_id");--> statement-breakpoint
CREATE INDEX "question_classification_nodes_course_idx" ON "question_classification_nodes" USING btree ("run_id","course_code","kind");--> statement-breakpoint
-- Automatic search metadata is private and append-only. It does not change the signed question or any review.
REVOKE ALL ON public.question_classification_runs,public.question_classification_nodes,public.question_classification_bindings FROM PUBLIC,anon,authenticated;
--> statement-breakpoint
CREATE FUNCTION public.f34_classification_run_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'classification_run_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.activated_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'classification_stage_first';END IF;
  IF NEW.actor_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.user_id=NEW.actor_id AND p.role='admin' AND p.deleted_at IS NULL AND p.suspended_at IS NULL) THEN RAISE EXCEPTION 'classification_admin_required';END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.namespace,NEW.queue_hash,NEW.rule_hash,NEW.rule_version,NEW.bundle_hash,NEW.corpus_hash,NEW.membership_hash,NEW.expected_count,NEW.expected_nodes,NEW.classification_kind,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.namespace,OLD.queue_hash,OLD.rule_hash,OLD.rule_version,OLD.bundle_hash,OLD.corpus_hash,OLD.membership_hash,OLD.expected_count,OLD.expected_nodes,OLD.classification_kind,OLD.created_at)
  OR (NEW.actor_id IS DISTINCT FROM OLD.actor_id AND (NEW.actor_id IS NOT NULL OR EXISTS(SELECT 1 FROM auth.users u WHERE u.id=OLD.actor_id)))
 THEN RAISE EXCEPTION 'classification_run_immutable';END IF;
 IF (NEW.status,NEW.activated_at,NEW.withdrawn_at) IS NOT DISTINCT FROM (OLD.status,OLD.activated_at,OLD.withdrawn_at) THEN RETURN NEW;END IF;
 IF OLD.status='draft' AND NEW.status='active' AND NEW.activated_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
  IF (SELECT count(*) FROM public.question_classification_nodes n WHERE n.run_id=NEW.id)<>NEW.expected_nodes
    OR (SELECT count(*) FROM public.question_classification_bindings b WHERE b.run_id=NEW.id)<>NEW.expected_count
    OR EXISTS(SELECT 1 FROM public.question_classification_bindings b JOIN public.question_bank q ON q.id=b.question_id WHERE b.run_id=NEW.id AND
      (q.visibility<>'public' OR q.catalog_status<>'published' OR q.validation_kind IS DISTINCT FROM 'remoa_team_attested' OR q.content_hash IS DISTINCT FROM b.content_hash OR q.profession_code IS DISTINCT FROM b.course_code OR q.enamed_area_id IS NOT NULL OR q.enamed_topic_id IS NOT NULL OR NOT public.f33_team_question_visible(q.id,q.content_hash)))
  THEN RAISE EXCEPTION 'classification_index_incomplete';END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='active' AND NEW.status='withdrawn' AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at AND NEW.withdrawn_at IS NOT NULL THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'classification_phase_immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_classification_run_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_classification_runs FOR EACH ROW EXECUTE FUNCTION public.f34_classification_run_guard();
--> statement-breakpoint
CREATE FUNCTION public.f34_classification_node_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE phase text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'classification_node_immutable';END IF;
 IF TG_OP='UPDATE' THEN IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;RAISE EXCEPTION 'classification_node_immutable';END IF;
 IF EXISTS(SELECT 1 FROM public.question_classification_nodes n WHERE n.id=NEW.id AND (n.run_id,n.course_code,n.kind,n.parent_id,n.code,n.label) IS NOT DISTINCT FROM (NEW.run_id,NEW.course_code,NEW.kind,NEW.parent_id,NEW.code,NEW.label)) THEN RETURN NEW;END IF;
 SELECT status INTO phase FROM public.question_classification_runs WHERE id=NEW.run_id FOR UPDATE;
 IF phase IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'classification_node_stage_required';END IF;
 IF NEW.kind='topic' AND NOT EXISTS(SELECT 1 FROM public.question_classification_nodes p WHERE p.id=NEW.parent_id AND p.run_id=NEW.run_id AND p.course_code=NEW.course_code AND p.kind='area') THEN RAISE EXCEPTION 'classification_parent_mismatch';END IF;
 IF EXISTS(SELECT 1 FROM public.enamed_taxonomy t WHERE t.id=NEW.id) THEN RAISE EXCEPTION 'classification_namespace_collision';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_classification_node_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_classification_nodes FOR EACH ROW EXECUTE FUNCTION public.f34_classification_node_guard();
--> statement-breakpoint
CREATE FUNCTION public.f34_classification_binding_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE phase text; stem text; signal jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'classification_binding_immutable';END IF;
 IF TG_OP='UPDATE' THEN IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;RAISE EXCEPTION 'classification_binding_immutable';END IF;
 IF EXISTS(SELECT 1 FROM public.question_classification_bindings b WHERE b.question_id=NEW.question_id AND (b.run_id,b.content_hash,b.payload_hash,b.course_code,b.area_id,b.topic_id,b.evidence) IS NOT DISTINCT FROM (NEW.run_id,NEW.content_hash,NEW.payload_hash,NEW.course_code,NEW.area_id,NEW.topic_id,NEW.evidence)) THEN RETURN NEW;END IF;
 SELECT status INTO phase FROM public.question_classification_runs WHERE id=NEW.run_id FOR UPDATE;
 IF phase IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'classification_binding_stage_required';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.question_classification_nodes a JOIN public.question_classification_nodes t ON t.parent_id=a.id
   WHERE a.id=NEW.area_id AND t.id=NEW.topic_id AND a.kind='area' AND t.kind='topic' AND a.run_id=NEW.run_id AND t.run_id=NEW.run_id AND a.course_code=NEW.course_code AND t.course_code=NEW.course_code)
 THEN RAISE EXCEPTION 'classification_taxonomy_mismatch';END IF;
 SELECT q.stem INTO stem FROM public.question_bank q JOIN public.question_team_items i ON i.question_id=q.id JOIN public.question_team_batches b ON b.id=i.batch_id
 WHERE q.id=NEW.question_id AND q.visibility='public' AND q.catalog_status='published' AND q.validation_kind='remoa_team_attested'
  AND q.enamed_area_id IS NULL AND q.enamed_topic_id IS NULL AND q.profession_code=NEW.course_code AND i.profession_code=NEW.course_code
  AND q.content_hash=NEW.content_hash AND q.reviewed_hash=NEW.content_hash AND i.content_hash=NEW.content_hash AND i.payload_hash=NEW.payload_hash
  AND b.namespace='g29-cp21-20261019' AND b.activated_at IS NOT NULL AND b.revoked_at IS NULL AND public.f33_team_question_visible(q.id,q.content_hash);
 IF stem IS NULL THEN RAISE EXCEPTION 'classification_membership_hash_mismatch';END IF;
 IF jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.evidence->'signals') IS DISTINCT FROM 'array'
  OR coalesce(NEW.evidence->>'ruleId','') !~ ('^'||NEW.course_code||'\.[0-9]+$')
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.evidence) k WHERE k NOT IN ('ruleId','signals'))
  OR (SELECT count(DISTINCT e->>'pattern') FROM jsonb_array_elements(NEW.evidence->'signals') e)<2
 THEN RAISE EXCEPTION 'classification_evidence_required';END IF;
 FOR signal IN SELECT value FROM jsonb_array_elements(NEW.evidence->'signals') LOOP
  IF jsonb_typeof(signal) IS DISTINCT FROM 'object' OR coalesce(signal->>'start','') !~ '^[0-9]{1,7}$' OR coalesce(signal->>'end','') !~ '^[0-9]{1,7}$'
    OR coalesce(signal->>'pattern','')='' OR coalesce(signal->>'text','')='' OR (signal->>'end')::integer<=(signal->>'start')::integer
    OR substr(stem,(signal->>'start')::integer+1,(signal->>'end')::integer-(signal->>'start')::integer) IS DISTINCT FROM signal->>'text'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(signal) k WHERE k NOT IN ('pattern','start','end','text'))
  THEN RAISE EXCEPTION 'classification_evidence_mismatch';END IF;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER f34_classification_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON public.question_classification_bindings FOR EACH ROW EXECUTE FUNCTION public.f34_classification_binding_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f34_classification_run_guard(),public.f34_classification_node_guard(),public.f34_classification_binding_guard() FROM PUBLIC,anon,authenticated;
