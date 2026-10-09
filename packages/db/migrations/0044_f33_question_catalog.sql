CREATE TABLE "exam_papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"document_id" uuid,
	"answer_key_document_id" uuid,
	"name" text NOT NULL,
	"institution" text NOT NULL,
	"year" integer NOT NULL,
	"edition" text NOT NULL,
	"booklet" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"duration_sec" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"key_final" boolean DEFAULT false NOT NULL,
	"key_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_papers_edition_booklet_version_uq" UNIQUE("source_id","edition","booklet","version"),
	CONSTRAINT "exam_papers_status_chk" CHECK ("exam_papers"."status" in ('draft','published','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "exam_question_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"original_number" text NOT NULL,
	"original_keys" jsonb,
	"key_revision" text,
	"annulled" boolean DEFAULT false NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_occurrences_paper_number_uq" UNIQUE("paper_id","original_number"),
	CONSTRAINT "exam_occurrences_paper_ordinal_uq" UNIQUE("paper_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"selected_key" text,
	"correct" boolean,
	"elapsed_ms" integer NOT NULL,
	"revision" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_answers_item_mutation_uq" UNIQUE("item_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "question_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"pages" integer,
	"mime" text DEFAULT 'application/pdf' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_documents_limits_chk" CHECK ("question_documents"."bytes" between 1 and 104857600 and ("question_documents"."pages" is null or "question_documents"."pages" between 1 and 500))
);
--> statement-breakpoint
CREATE TABLE "question_editorial_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_name" text NOT NULL,
	"reviewer_crm" text NOT NULL,
	"content_hash" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"reference_date" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_editorial_decision_chk" CHECK ("question_editorial_reviews"."decision" in ('approved','changes_requested','rejected')),
	CONSTRAINT "question_editorial_identity_chk" CHECK (length(btrim("question_editorial_reviews"."reviewer_name")) > 0 and length(btrim("question_editorial_reviews"."reviewer_crm")) > 0 and length(btrim("question_editorial_reviews"."reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE "question_generation_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"payload_object_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"question_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_generation_candidates_run_ordinal_uq" UNIQUE("run_id","ordinal"),
	CONSTRAINT "question_generation_candidates_state_chk" CHECK (state in ('pending','needs_review','accepted','rejected','duplicate'))
);
--> statement-breakpoint
CREATE TABLE "question_generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"producer" text NOT NULL,
	"request_key" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"board_id" uuid,
	"board_version" integer,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"payload_object_key" text,
	"payload_hash" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_runs_owner_request_uq" UNIQUE("user_id","producer","request_key")
);
--> statement-breakpoint
CREATE TABLE "question_import_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"chunk_id" uuid,
	"ordinal" integer NOT NULL,
	"original_number" text,
	"payload" jsonb NOT NULL,
	"confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issues" text[] DEFAULT '{}' NOT NULL,
	"fingerprint" text,
	"duplicate_of" uuid,
	"question_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_candidates_import_ordinal_uq" UNIQUE("import_id","ordinal"),
	CONSTRAINT "question_candidates_state_chk" CHECK (state in ('pending','needs_review','accepted','rejected','duplicate'))
);
--> statement-breakpoint
CREATE TABLE "question_import_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"first_page" integer NOT NULL,
	"last_page" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload_object_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_chunks_document_version_pages_uq" UNIQUE("document_id","parser_version","first_page","last_page"),
	CONSTRAINT "question_chunks_pages_chk" CHECK ("question_import_chunks"."first_page" > 0 and "question_import_chunks"."last_page" >= "question_import_chunks"."first_page" and "question_import_chunks"."last_page" - "question_import_chunks"."first_page" < 10)
);
--> statement-breakpoint
CREATE TABLE "question_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"paper_id" uuid,
	"document_id" uuid NOT NULL,
	"answer_key_document_id" uuid,
	"idempotency_key" text NOT NULL,
	"parser_version" text NOT NULL,
	"ocr_version" text,
	"ocr_enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_pages" integer DEFAULT 0 NOT NULL,
	"completed_pages" integer DEFAULT 0 NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"reservation_id" uuid,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_imports_actor_key_uq" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "question_imports_status_chk" CHECK (status in ('queued','validating','extracting','ocr','segmenting','matching','review','completed','failed','cancelled','budget_paused')),
	CONSTRAINT "question_imports_budget_chk" CHECK ("question_imports"."budget_cents" >= 0 and "question_imports"."cost_cents" between 0 and "question_imports"."budget_cents")
);
--> statement-breakpoint
CREATE TABLE "question_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"import_id" uuid,
	"event_key" text NOT NULL,
	"target" text NOT NULL,
	"payload_reference" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"delivered_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_outbox_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "question_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_session_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"original_number" text,
	"payload_public" jsonb NOT NULL,
	"reference_snapshot" jsonb NOT NULL,
	"shuffle_map" jsonb,
	"selected_key" text,
	"doubtful" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_items_id_session_owner_uq" UNIQUE("id","session_id","user_id"),
	CONSTRAINT "question_items_session_position_uq" UNIQUE("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "question_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"paper_id" uuid,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_sessions_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "question_sessions_owner_key_uq" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "question_sessions_mode_chk" CHECK ("question_sessions"."mode" in ('study','simulation')),
	CONSTRAINT "question_sessions_status_chk" CHECK ("question_sessions"."status" in ('active','finished','expired'))
);
--> statement-breakpoint
CREATE TABLE "question_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"publisher" text NOT NULL,
	"url" text NOT NULL,
	"rights_status" text DEFAULT 'pending' NOT NULL,
	"rights_evidence" text,
	"rights_scope" text,
	"rights_expires_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_sources_rights_chk" CHECK (rights_status in ('pending','authorized','restricted','revoked')),
	CONSTRAINT "question_sources_evidence_chk" CHECK ("question_sources"."rights_status" <> 'authorized' or nullif(btrim("question_sources"."rights_evidence"), '') is not null)
);
--> statement-breakpoint
CREATE TABLE "question_user_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"doubtful" boolean DEFAULT false NOT NULL,
	"annotation" text DEFAULT '' NOT NULL,
	"last_answer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_user_state_owner_question_uq" UNIQUE("user_id","question_id")
);
--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_correct_key_chk";--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_alternatives_chk";--> statement-breakpoint
ALTER TABLE "question_bank" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "origin" text DEFAULT 'ai_generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "catalog_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "rights_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "availability" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "canonical_id" uuid;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "integrity_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "key_final" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "reviewed_hash" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "reviewer_name" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "reviewer_crm" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "reference_date" text;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "assets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_source_id_question_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."question_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_document_id_question_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_answer_key_document_id_question_documents_id_fk" FOREIGN KEY ("answer_key_document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_question_occurrences" ADD CONSTRAINT "exam_question_occurrences_paper_id_exam_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."exam_papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_question_occurrences" ADD CONSTRAINT "exam_question_occurrences_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_item_owner_fk" FOREIGN KEY ("item_id","session_id","user_id") REFERENCES "public"."question_session_items"("id","session_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_documents" ADD CONSTRAINT "question_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_documents" ADD CONSTRAINT "question_documents_source_id_question_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."question_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_reviews_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_editorial_reviews" ADD CONSTRAINT "question_editorial_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generation_candidates" ADD CONSTRAINT "question_generation_candidates_run_id_question_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."question_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generation_candidates" ADD CONSTRAINT "question_generation_candidates_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_candidates" ADD CONSTRAINT "question_import_candidates_import_id_question_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."question_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_candidates" ADD CONSTRAINT "question_import_candidates_chunk_id_question_import_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."question_import_chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_candidates" ADD CONSTRAINT "question_import_candidates_duplicate_of_question_bank_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_candidates" ADD CONSTRAINT "question_import_candidates_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_chunks" ADD CONSTRAINT "question_import_chunks_import_id_question_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."question_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_import_chunks" ADD CONSTRAINT "question_import_chunks_document_id_question_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_source_id_question_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."question_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_paper_id_exam_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."exam_papers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_document_id_question_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_answer_key_document_id_question_documents_id_fk" FOREIGN KEY ("answer_key_document_id") REFERENCES "public"."question_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_outbox" ADD CONSTRAINT "question_outbox_run_id_question_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."question_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_outbox" ADD CONSTRAINT "question_outbox_import_id_question_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."question_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_reports" ADD CONSTRAINT "question_reports_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_session_items" ADD CONSTRAINT "question_session_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_session_items" ADD CONSTRAINT "question_session_items_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_session_items" ADD CONSTRAINT "question_items_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."question_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sessions" ADD CONSTRAINT "question_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sessions" ADD CONSTRAINT "question_sessions_paper_id_exam_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."exam_papers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_user_state" ADD CONSTRAINT "question_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_user_state" ADD CONSTRAINT "question_user_state_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_user_state" ADD CONSTRAINT "question_user_state_last_answer_id_question_answers_id_fk" FOREIGN KEY ("last_answer_id") REFERENCES "public"."question_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_papers_source_idx" ON "exam_papers" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "exam_papers_document_idx" ON "exam_papers" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "exam_papers_key_document_idx" ON "exam_papers" USING btree ("answer_key_document_id");--> statement-breakpoint
CREATE INDEX "exam_papers_status_year_idx" ON "exam_papers" USING btree ("status","year");--> statement-breakpoint
CREATE INDEX "exam_occurrences_question_idx" ON "exam_question_occurrences" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_answers_owner_submitted_idx" ON "question_answers" USING btree ("user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "question_answers_session_idx" ON "question_answers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "question_documents_actor_idx" ON "question_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "question_documents_source_hash_idx" ON "question_documents" USING btree ("source_id","sha256");--> statement-breakpoint
CREATE INDEX "question_editorial_question_hash_idx" ON "question_editorial_reviews" USING btree ("question_id","content_hash");--> statement-breakpoint
CREATE INDEX "question_editorial_reviewer_idx" ON "question_editorial_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "question_generation_candidates_question_idx" ON "question_generation_candidates" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_runs_reconcile_idx" ON "question_generation_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "question_candidates_chunk_idx" ON "question_import_candidates" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "question_candidates_duplicate_idx" ON "question_import_candidates" USING btree ("duplicate_of");--> statement-breakpoint
CREATE INDEX "question_candidates_question_idx" ON "question_import_candidates" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_candidates_fingerprint_idx" ON "question_import_candidates" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "question_chunks_import_idx" ON "question_import_chunks" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "question_chunks_poll_idx" ON "question_import_chunks" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "question_imports_poll_idx" ON "question_imports" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "question_imports_source_idx" ON "question_imports" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "question_imports_paper_idx" ON "question_imports" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "question_imports_document_idx" ON "question_imports" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "question_imports_key_document_idx" ON "question_imports" USING btree ("answer_key_document_id");--> statement-breakpoint
CREATE INDEX "question_outbox_poll_idx" ON "question_outbox" USING btree ("delivered_at","lease_until");--> statement-breakpoint
CREATE INDEX "question_outbox_run_idx" ON "question_outbox" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "question_outbox_import_idx" ON "question_outbox" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "question_reports_owner_idx" ON "question_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "question_reports_question_idx" ON "question_reports" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_items_owner_idx" ON "question_session_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "question_items_question_idx" ON "question_session_items" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_sessions_paper_idx" ON "question_sessions" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "question_sessions_owner_created_idx" ON "question_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "question_user_state_question_idx" ON "question_user_state" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_user_state_answer_idx" ON "question_user_state" USING btree ("last_answer_id");--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_canonical_id_question_bank_id_fk" FOREIGN KEY ("canonical_id") REFERENCES "public"."question_bank"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_bank_catalog_created_idx" ON "question_bank" USING btree ("visibility","catalog_status","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "question_bank_canonical_idx" ON "question_bank" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "question_bank_source_idx" ON "question_bank" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "question_bank_fingerprint_idx" ON "question_bank" USING btree ("fingerprint");--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_origin_chk" CHECK ("question_bank"."origin" in ('official_exam', 'remoa_authored', 'ai_generated', 'user_authored'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_visibility_chk" CHECK ("question_bank"."visibility" in ('private', 'public'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_catalog_status_chk" CHECK ("question_bank"."catalog_status" in ('draft', 'in_review', 'approved', 'published', 'withdrawn', 'rejected'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_rights_chk" CHECK ("question_bank"."rights_status" in ('pending', 'authorized', 'restricted', 'revoked'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_availability_chk" CHECK ("question_bank"."availability" in ('active', 'annulled', 'superseded', 'unavailable'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_owner_chk" CHECK ("question_bank"."user_id" is not null or ("question_bank"."visibility" = 'public' and "question_bank"."origin" in ('official_exam','remoa_authored')));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_publish_chk" CHECK ("question_bank"."catalog_status" <> 'published' or ("question_bank"."visibility" = 'public' and "question_bank"."rights_status" = 'authorized' and "question_bank"."status" = 'approved' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and "question_bank"."enamed_area_id" is not null and "question_bank"."enamed_topic_id" is not null and "question_bank"."content_hash" is not null and "question_bank"."reviewed_hash" = "question_bank"."content_hash" and nullif(btrim("question_bank"."reviewer_name"),'') is not null and nullif(btrim("question_bank"."reviewer_crm"),'') is not null and "question_bank"."reference_date" is not null));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_correct_key_chk" CHECK ("question_bank"."correct_key" is null or "question_bank"."correct_key" in ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_alternatives_chk" CHECK ("question_bank"."alternatives" is null or (jsonb_typeof("question_bank"."alternatives") = 'array' and jsonb_array_length("question_bank"."alternatives") between 2 and 10));
--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_publish_chk";--> statement-breakpoint
ALTER TABLE "question_bank" DROP CONSTRAINT "question_bank_objective_chk";--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_source_id_question_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."question_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_public_privacy_chk" CHECK ("question_bank"."visibility" <> 'public' or ("question_bank"."board_id" is null and cardinality("question_bank"."card_ids") = 0 and "question_bank"."evidences" = '[]'::jsonb));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_publish_chk" CHECK ("question_bank"."catalog_status" <> 'published' or ("question_bank"."visibility" = 'public' and "question_bank"."rights_status" = 'authorized' and "question_bank"."status" = 'approved' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and "question_bank"."enamed_area_id" is not null and "question_bank"."enamed_topic_id" is not null and "question_bank"."content_hash" is not null and "question_bank"."reviewed_hash" is not null and "question_bank"."reviewed_hash" = "question_bank"."content_hash" and nullif(btrim("question_bank"."reviewer_name"),'') is not null and nullif(btrim("question_bank"."reviewer_crm"),'') is not null and "question_bank"."reference_date" is not null));--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_objective_chk" CHECK (("question_bank"."type" = 'objective' and "question_bank"."alternatives" is not null and ("question_bank"."correct_key" is not null or "question_bank"."availability" = 'annulled')) or ("question_bank"."type" = 'discursive' and "question_bank"."alternatives" is null and "question_bank"."correct_key" is null));
--> statement-breakpoint
-- F33 backfill keeps all legacy personal questions private; no editorial approval is inferred.
UPDATE public.question_bank SET canonical_id = coalesce(canonical_id, id),
  origin = CASE source WHEN 'ai' THEN 'ai_generated' WHEN 'student' THEN 'user_authored' ELSE 'user_authored' END;
--> statement-breakpoint
WITH RECURSIVE roots AS (SELECT id, id AS root, supersedes_id, ARRAY[id] AS path FROM public.question_bank UNION ALL SELECT r.id, b.id, b.supersedes_id, r.path || b.id FROM roots r JOIN public.question_bank b ON b.id = r.supersedes_id WHERE NOT b.id = ANY(r.path)), final AS (SELECT DISTINCT ON (id) id, root FROM roots ORDER BY id, cardinality(path) DESC) UPDATE public.question_bank q SET canonical_id = f.root FROM final f WHERE q.id = f.id;
--> statement-breakpoint
ALTER TABLE public.question_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_sources FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_documents FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.exam_papers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.exam_papers FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.exam_question_occurrences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.exam_question_occurrences FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_imports FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_import_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_import_chunks FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_import_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_import_candidates FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_generation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_generation_runs FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_generation_candidates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_generation_candidates FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_outbox FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_editorial_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_editorial_reviews FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_sessions FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_session_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_session_items FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_answers FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_user_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_user_state FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE public.question_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.question_reports FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE POLICY question_sources_authorized ON public.question_sources FOR SELECT TO authenticated USING (rights_status = 'authorized' AND (rights_expires_at IS NULL OR rights_expires_at > now()));
--> statement-breakpoint
GRANT SELECT (id, name, publisher, url, rights_status, rights_expires_at) ON public.question_sources TO authenticated;
--> statement-breakpoint
DROP POLICY question_bank_select ON public.question_bank;
--> statement-breakpoint
CREATE POLICY question_bank_select ON public.question_bank FOR SELECT TO authenticated USING (
 (user_id = (select auth.uid()) AND visibility = 'private') OR
 (visibility = 'public' AND catalog_status = 'published' AND rights_status = 'authorized' AND availability IN ('active','annulled') AND EXISTS (SELECT 1 FROM public.question_sources s WHERE s.id = source_id AND s.rights_status = 'authorized' AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now())))
);
--> statement-breakpoint
GRANT SELECT (origin, visibility, catalog_status, availability, canonical_id, source_id, published_at, assets) ON public.question_bank TO authenticated;
--> statement-breakpoint
CREATE POLICY question_sessions_owner ON public.question_sessions FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT (id, user_id, mode, paper_id, config, status, revision, started_at, deadline, finished_at, created_at, updated_at) ON public.question_sessions TO authenticated;
--> statement-breakpoint
CREATE POLICY question_items_owner ON public.question_session_items FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT (id, user_id, session_id, question_id, position, original_number, payload_public, selected_key, doubtful, answered, revision, created_at, updated_at) ON public.question_session_items TO authenticated;
--> statement-breakpoint
CREATE POLICY question_answers_owner ON public.question_answers FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT (id, user_id, session_id, item_id, mutation_id, selected_key, elapsed_ms, revision, submitted_at) ON public.question_answers TO authenticated;
--> statement-breakpoint
CREATE POLICY question_state_owner ON public.question_user_state FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT ON public.question_user_state TO authenticated;
--> statement-breakpoint
CREATE POLICY question_reports_owner ON public.question_reports FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT ON public.question_reports TO authenticated;
--> statement-breakpoint
-- Administrative, staging, ledger and document tables are API/server-only. No generic JWT admin bypass.
-- Session report/reference/correctness is server-only even for owners; API checks study answered / simulation finished.
CREATE FUNCTION public.f33_validate_question() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
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
   (NEW.stem, NEW.alternatives, NEW.correct_key, NEW.expected_answer, NEW.explanation, NEW.key_points, NEW.distractor_notes, NEW.assets)
   IS DISTINCT FROM (OLD.stem, OLD.alternatives, OLD.correct_key, OLD.expected_answer, OLD.explanation, OLD.key_points, OLD.distractor_notes, OLD.assets)
 THEN RAISE EXCEPTION 'published_content_immutable_create_version'; END IF;
 IF NEW.catalog_status = 'published' THEN
  IF nullif(btrim(NEW.explanation),'') IS NULL THEN RAISE EXCEPTION 'reviewed_explanation_required'; END IF;
  IF NEW.content_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid_content_hash'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_sources s WHERE s.id = NEW.source_id AND s.rights_status = 'authorized' AND (s.rights_expires_at IS NULL OR s.rights_expires_at > now())) THEN RAISE EXCEPTION 'source_rights_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.question_editorial_reviews r JOIN public.profiles p ON p.user_id = r.user_id
    WHERE r.question_id = NEW.id AND r.content_hash = NEW.content_hash AND r.decision = 'approved'
      AND p.role = 'reviewer' AND nullif(btrim(p.crm),'') IS NOT NULL AND r.reviewer_crm = p.crm AND r.reviewer_name = p.name
      AND r.reviewer_crm = NEW.reviewer_crm AND r.reviewer_name = NEW.reviewer_name AND r.reference_date = NEW.reference_date)
  THEN RAISE EXCEPTION 'medical_review_required'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_validate_question() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER f33_validate_question BEFORE INSERT OR UPDATE ON public.question_bank FOR EACH ROW EXECUTE FUNCTION public.f33_validate_question();
--> statement-breakpoint
CREATE FUNCTION public.f33_source_rights_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
 IF NEW.rights_status <> 'authorized' OR (NEW.rights_expires_at IS NOT NULL AND NEW.rights_expires_at <= now()) THEN
  UPDATE public.question_bank SET catalog_status = 'withdrawn', rights_status = NEW.rights_status, availability = 'unavailable'
  WHERE source_id = NEW.id AND catalog_status = 'published';
  UPDATE public.exam_papers SET status = 'withdrawn' WHERE source_id = NEW.id AND status = 'published';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_source_rights_change() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER f33_source_rights_change AFTER UPDATE OF rights_status, rights_expires_at ON public.question_sources FOR EACH ROW EXECUTE FUNCTION public.f33_source_rights_change();
--> statement-breakpoint
CREATE FUNCTION public.f33_answers_append_only() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
 IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'question_answers_append_only';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_answers_append_only() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER f33_answers_append_only BEFORE UPDATE OR DELETE ON public.question_answers FOR EACH ROW EXECUTE FUNCTION public.f33_answers_append_only();

--> statement-breakpoint
ALTER TABLE "question_imports" ADD COLUMN "excluded_pages" jsonb DEFAULT '[]'::jsonb NOT NULL;