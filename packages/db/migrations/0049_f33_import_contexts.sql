CREATE TABLE "question_import_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence_object_key" text NOT NULL,
	"original_text" text,
	"declared_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"resolution" jsonb,
	"resolution_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_contexts_import_evidence_uq" UNIQUE("import_id","evidence_hash"),
	CONSTRAINT "question_contexts_revision_chk" CHECK ("question_import_contexts"."revision" >= 0),
	CONSTRAINT "question_contexts_status_chk" CHECK ("question_import_contexts"."status" in ('unresolved','bound','non_question')),
	CONSTRAINT "question_contexts_hash_chk" CHECK ("question_import_contexts"."evidence_hash" ~ '^[a-f0-9]{64}$' and ("question_import_contexts"."resolution_hash" is null or "question_import_contexts"."resolution_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "question_contexts_key_chk" CHECK ("question_import_contexts"."evidence_object_key" like 'questions/imports/' || "question_import_contexts"."import_id"::text || '/contexts/%'),
	CONSTRAINT "question_contexts_resolution_chk" CHECK (("question_import_contexts"."status" = 'unresolved' or ("question_import_contexts"."resolution" is not null and "question_import_contexts"."resolution_hash" is not null)) and ("question_import_contexts"."status" <> 'bound' or "question_import_contexts"."resolution"->>'decision' IS NOT DISTINCT FROM 'bind') and ("question_import_contexts"."status" <> 'non_question' or "question_import_contexts"."resolution"->>'decision' IS NOT DISTINCT FROM 'non_question') and ("question_import_contexts"."status" <> 'unresolved' or ("question_import_contexts"."resolution" is null and "question_import_contexts"."resolution_hash" is null)))
);
--> statement-breakpoint
ALTER TABLE "question_imports" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_import_contexts" ADD CONSTRAINT "question_import_contexts_import_id_question_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."question_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_contexts" ADD CONSTRAINT "question_import_contexts_document_id_question_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_contexts_document_idx" ON "question_import_contexts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "question_contexts_import_status_idx" ON "question_import_contexts" USING btree ("import_id","status");--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_revision_chk" CHECK ("question_imports"."revision" >= 0);
--> statement-breakpoint
ALTER TABLE public.question_import_contexts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_import_contexts FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.question_import_contexts TO service_role;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.question_import_contexts ADD CONSTRAINT question_contexts_json_chk CHECK (
 jsonb_typeof(declared_numbers)='array' AND jsonb_typeof(provenance)='array' AND jsonb_typeof(image_refs)='array'
 AND (resolution IS NULL OR jsonb_typeof(resolution)='object')
);
--> statement-breakpoint
-- Evidence cannot be rewritten by a resolution. Publication/history checks and transitive draft invalidation
-- run in the API transaction with lock order import→paper→contexts(id)→candidates(id)→questions(id).
CREATE FUNCTION public.question_context_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.question_imports i WHERE i.id=NEW.import_id AND i.document_id=NEW.document_id) THEN
      RAISE EXCEPTION 'context_document_mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.import_id,NEW.document_id,NEW.evidence_hash,NEW.evidence_object_key,NEW.original_text,NEW.declared_numbers,NEW.provenance,NEW.image_refs)
      IS DISTINCT FROM ROW(OLD.id,OLD.import_id,OLD.document_id,OLD.evidence_hash,OLD.evidence_object_key,OLD.original_text,OLD.declared_numbers,OLD.provenance,OLD.image_refs) THEN
      RAISE EXCEPTION 'context_evidence_immutable' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.status,NEW.resolution,NEW.resolution_hash) IS DISTINCT FROM ROW(OLD.status,OLD.resolution,OLD.resolution_hash)
      AND NEW.revision <> OLD.revision+1 THEN
      RAISE EXCEPTION 'context_revision_required' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.question_context_evidence_guard() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER question_context_evidence_guard BEFORE INSERT OR UPDATE ON public.question_import_contexts
FOR EACH ROW EXECUTE FUNCTION public.question_context_evidence_guard();
