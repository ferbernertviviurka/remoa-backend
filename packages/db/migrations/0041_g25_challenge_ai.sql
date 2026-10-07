-- F30 (G25, CCR-090, D-1600–D-1610): Desafio com IA, banco de questões, rubricas por card, resumo do mapa, taxonomia do ENAMED.
-- Additive only: seven new tables and two usage_counters columns; F04 `sessions`/`attempts` are untouched. Drizzle-generated DDL,
-- then RLS, grants, triggers and the taxonomy backfill by hand (below the marker). Down (manual, in this order):
--   DROP TABLE public.challenge_attempts, public.challenge_items, public.challenge_sessions, public.card_rubrics, public.map_summaries,
--     public.question_bank, public.enamed_taxonomy;
--   DROP FUNCTION public.challenge_attempts_append_only();
--   ALTER TABLE public.usage_counters DROP COLUMN ai_question_batches, DROP COLUMN ai_summaries;
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <journal `when` of 0041>;
CREATE TABLE "card_rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"card_hash" text NOT NULL,
	"essential_points" text[] NOT NULL,
	"accepted_variants" text[] DEFAULT '{}'::text[] NOT NULL,
	"critical_errors" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'auto' NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_rubrics_card_hash_uq" UNIQUE("card_id","card_hash"),
	CONSTRAINT "card_rubrics_status_chk" CHECK ("card_rubrics"."status" in ('auto', 'edited', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "challenge_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_no" smallint NOT NULL,
	"answer" jsonb NOT NULL,
	"answer_hash" text NOT NULL,
	"verdict" text,
	"covered" text[] DEFAULT '{}'::text[] NOT NULL,
	"missing" text[] DEFAULT '{}'::text[] NOT NULL,
	"critical_error" boolean DEFAULT false NOT NULL,
	"manipulation" boolean DEFAULT false NOT NULL,
	"feedback" text,
	"hint" text,
	"used_hint" boolean DEFAULT false NOT NULL,
	"confidence" real,
	"graded_by" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"latency_ms" integer,
	"rating" text,
	"disputed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_attempts_no_chk" CHECK ("challenge_attempts"."attempt_no" between 1 and 2),
	CONSTRAINT "challenge_attempts_graded_by_chk" CHECK ("challenge_attempts"."graded_by" in ('deterministic', 'ai', 'prefilter', 'pending')),
	CONSTRAINT "challenge_attempts_verdict_chk" CHECK (("challenge_attempts"."verdict" is null) = ("challenge_attempts"."graded_by" = 'pending') and ("challenge_attempts"."verdict" is null or "challenge_attempts"."verdict" in ('correct', 'partial', 'incorrect'))),
	CONSTRAINT "challenge_attempts_rating_chk" CHECK ("challenge_attempts"."rating" is null or "challenge_attempts"."rating" in ('again', 'hard', 'good', 'easy')),
	CONSTRAINT "challenge_attempts_confidence_chk" CHECK ("challenge_attempts"."confidence" is null or "challenge_attempts"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "challenge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"card_id" uuid,
	"sub_id" text DEFAULT '' NOT NULL,
	"bank_id" uuid,
	"type" text NOT NULL,
	"payload_public" jsonb NOT NULL,
	"reference_ref" jsonb NOT NULL,
	"shuffle_map" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_items_session_position_uq" UNIQUE("session_id","position"),
	CONSTRAINT "challenge_items_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "challenge_items_kind_chk" CHECK ("challenge_items"."kind" in ('card', 'bank')),
	CONSTRAINT "challenge_items_type_chk" CHECK ("challenge_items"."type" in ('discursive', 'objective', 'hidden_card', 'edge', 'next_step', 'occlusion', 'case'))
);
--> statement-breakpoint
CREATE TABLE "challenge_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"board_id" uuid,
	"scope" jsonb NOT NULL,
	"format" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"score" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenge_sessions_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "challenge_sessions_format_chk" CHECK ("challenge_sessions"."format" in ('generated', 'map')),
	CONSTRAINT "challenge_sessions_status_chk" CHECK ("challenge_sessions"."status" in ('active', 'finished', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "enamed_taxonomy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"area" "area" NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"matrix_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enamed_taxonomy_code_unique" UNIQUE("code"),
	CONSTRAINT "enamed_taxonomy_matrix_ref_unique" UNIQUE("matrix_ref"),
	CONSTRAINT "enamed_taxonomy_kind_chk" CHECK ("enamed_taxonomy"."kind" in ('area', 'domain', 'competency', 'topic')),
	CONSTRAINT "enamed_taxonomy_root_chk" CHECK (("enamed_taxonomy"."kind" = 'area') = ("enamed_taxonomy"."parent_id" is null))
);
--> statement-breakpoint
CREATE TABLE "map_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"board_version" integer NOT NULL,
	"size" text NOT NULL,
	"focus" text NOT NULL,
	"content" jsonb NOT NULL,
	"cards_cited" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text,
	"prompt_version" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "map_summaries_size_chk" CHECK ("map_summaries"."size" in ('quick', 'standard', 'full')),
	CONSTRAINT "map_summaries_focus_chk" CHECK ("map_summaries"."focus" in ('overview', 'high_yield', 'exam_eve')),
	CONSTRAINT "map_summaries_content_chk" CHECK (jsonb_typeof("map_summaries"."content") = 'array')
);
--> statement-breakpoint
CREATE TABLE "question_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"board_id" uuid,
	"board_version" integer,
	"card_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"type" text NOT NULL,
	"difficulty" text NOT NULL,
	"stem" text NOT NULL,
	"alternatives" jsonb,
	"correct_key" text,
	"expected_answer" text NOT NULL,
	"key_points" text[] DEFAULT '{}'::text[] NOT NULL,
	"explanation" text,
	"distractor_notes" jsonb,
	"evidences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enamed_area_id" uuid,
	"enamed_domain_id" uuid,
	"enamed_competency_id" uuid,
	"enamed_topic_id" uuid,
	"enamed_confidence" real,
	"enamed_confirmed" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"prompt_id" text,
	"prompt_version" text,
	"model" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"stats" jsonb DEFAULT '{"seen":0,"correct":0,"partial":0,"incorrect":0}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_bank_type_chk" CHECK ("question_bank"."type" in ('discursive', 'objective')),
	CONSTRAINT "question_bank_difficulty_chk" CHECK ("question_bank"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "question_bank_source_chk" CHECK ("question_bank"."source" in ('ai', 'map', 'student')),
	CONSTRAINT "question_bank_status_chk" CHECK ("question_bank"."status" in ('draft', 'approved', 'archived')),
	CONSTRAINT "question_bank_correct_key_chk" CHECK ("question_bank"."correct_key" is null or "question_bank"."correct_key" in ('A', 'B', 'C', 'D')),
	CONSTRAINT "question_bank_objective_chk" CHECK (("question_bank"."type" = 'objective') = ("question_bank"."correct_key" is not null and "question_bank"."alternatives" is not null)),
	CONSTRAINT "question_bank_alternatives_chk" CHECK ("question_bank"."alternatives" is null or (jsonb_typeof("question_bank"."alternatives") = 'array' and jsonb_array_length("question_bank"."alternatives") = 4)),
	CONSTRAINT "question_bank_evidences_chk" CHECK (jsonb_typeof("question_bank"."evidences") = 'array'),
	CONSTRAINT "question_bank_confidence_chk" CHECK ("question_bank"."enamed_confidence" is null or "question_bank"."enamed_confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "ai_question_batches" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "ai_summaries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_rubrics" ADD CONSTRAINT "card_rubrics_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_attempts" ADD CONSTRAINT "challenge_attempts_item_user_fk" FOREIGN KEY ("item_id","user_id") REFERENCES "public"."challenge_items"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_items" ADD CONSTRAINT "challenge_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_items" ADD CONSTRAINT "challenge_items_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_items" ADD CONSTRAINT "challenge_items_bank_id_question_bank_id_fk" FOREIGN KEY ("bank_id") REFERENCES "public"."question_bank"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_items" ADD CONSTRAINT "challenge_items_session_user_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."challenge_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_sessions" ADD CONSTRAINT "challenge_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenge_sessions" ADD CONSTRAINT "challenge_sessions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enamed_taxonomy" ADD CONSTRAINT "enamed_taxonomy_parent_id_enamed_taxonomy_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."enamed_taxonomy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enamed_taxonomy" ADD CONSTRAINT "enamed_taxonomy_matrix_ref_matrix_items_id_fk" FOREIGN KEY ("matrix_ref") REFERENCES "public"."matrix_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_summaries" ADD CONSTRAINT "map_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_summaries" ADD CONSTRAINT "map_summaries_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_enamed_area_id_enamed_taxonomy_id_fk" FOREIGN KEY ("enamed_area_id") REFERENCES "public"."enamed_taxonomy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_enamed_domain_id_enamed_taxonomy_id_fk" FOREIGN KEY ("enamed_domain_id") REFERENCES "public"."enamed_taxonomy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_enamed_competency_id_enamed_taxonomy_id_fk" FOREIGN KEY ("enamed_competency_id") REFERENCES "public"."enamed_taxonomy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_enamed_topic_id_enamed_taxonomy_id_fk" FOREIGN KEY ("enamed_topic_id") REFERENCES "public"."enamed_taxonomy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_bank" ADD CONSTRAINT "question_bank_supersedes_id_question_bank_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."question_bank"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_attempts_graded_uq" ON "challenge_attempts" USING btree ("item_id","attempt_no") WHERE "challenge_attempts"."graded_by" <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_attempts_pending_uq" ON "challenge_attempts" USING btree ("item_id","attempt_no") WHERE "challenge_attempts"."graded_by" = 'pending';--> statement-breakpoint
CREATE INDEX "challenge_attempts_item_idx" ON "challenge_attempts" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "challenge_attempts_user_created_idx" ON "challenge_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "challenge_items_card_idx" ON "challenge_items" USING btree ("card_id") WHERE "challenge_items"."card_id" is not null;--> statement-breakpoint
CREATE INDEX "challenge_items_bank_idx" ON "challenge_items" USING btree ("bank_id") WHERE "challenge_items"."bank_id" is not null;--> statement-breakpoint
CREATE INDEX "challenge_sessions_user_started_idx" ON "challenge_sessions" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "challenge_sessions_board_idx" ON "challenge_sessions" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "enamed_taxonomy_parent_idx" ON "enamed_taxonomy" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "map_summaries_user_board_created_idx" ON "map_summaries" USING btree ("user_id","board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "map_summaries_board_idx" ON "map_summaries" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "question_bank_user_board_created_idx" ON "question_bank" USING btree ("user_id","board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "question_bank_user_topic_idx" ON "question_bank" USING btree ("user_id","enamed_topic_id");--> statement-breakpoint
CREATE INDEX "question_bank_board_idx" ON "question_bank" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "question_bank_supersedes_idx" ON "question_bank" USING btree ("supersedes_id") WHERE "question_bank"."supersedes_id" is not null;--> statement-breakpoint
-- ---- hand-written ------------------------------------------------------------------------------------------------------------
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.question_bank FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.challenge_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.card_rubrics FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.map_summaries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enamed_taxonomy FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- RLS on all seven. Every write goes through the API with the server connection (verdicts, grades, shuffles, quotas and versions
-- are server decisions, FR-38), so `authenticated` gets SELECT only, and on reference tables only the columns without reference (FR-36).
ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.challenge_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.challenge_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.challenge_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.card_rubrics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.map_summaries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.enamed_taxonomy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.question_bank, public.challenge_sessions, public.challenge_items, public.challenge_attempts, public.card_rubrics,
  public.map_summaries, public.enamed_taxonomy FROM anon, authenticated;--> statement-breakpoint
-- question_bank (D-1602, private): the owner reads own rows, without correct_key, expected_answer, key_points, explanation, distractor_notes.
CREATE POLICY question_bank_select ON public.question_bank FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
GRANT SELECT (id, user_id, board_id, board_version, card_ids, type, difficulty, stem, alternatives, evidences, enamed_area_id, enamed_domain_id,
  enamed_competency_id, enamed_topic_id, enamed_confidence, enamed_confirmed, source, prompt_id, prompt_version, model, status, stats, version,
  supersedes_id, created_at, updated_at) ON public.question_bank TO authenticated;--> statement-breakpoint
CREATE POLICY challenge_sessions_select ON public.challenge_sessions FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
GRANT SELECT ON public.challenge_sessions TO authenticated;--> statement-breakpoint
-- challenge_items: no reference_ref, no shuffle_map.
CREATE POLICY challenge_items_select ON public.challenge_items FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
GRANT SELECT (id, session_id, user_id, position, kind, card_id, sub_id, bank_id, type, payload_public, created_at) ON public.challenge_items TO authenticated;--> statement-breakpoint
CREATE POLICY challenge_attempts_select ON public.challenge_attempts FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
GRANT SELECT ON public.challenge_attempts TO authenticated;--> statement-breakpoint
CREATE POLICY map_summaries_select ON public.map_summaries FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
GRANT SELECT ON public.map_summaries TO authenticated;--> statement-breakpoint
-- card_rubrics: reference material, no policy, no grant (server only).
-- enamed_taxonomy (D-1604): public read, writes by migration/seed only.
CREATE POLICY enamed_taxonomy_select ON public.enamed_taxonomy FOR SELECT TO anon, authenticated USING (true);--> statement-breakpoint
GRANT SELECT ON public.enamed_taxonomy TO anon, authenticated;--> statement-breakpoint
-- challenge_attempts append-only (FR-38), server connection included. Allowed: INSERT; UPDATE that only flips disputed false -> true
-- (Discordar); DELETE cascaded from challenge_items (session or account removal: pg_trigger_depth() > 1 inside the FK action).
CREATE FUNCTION public.challenge_attempts_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.disputed AND NOT OLD.disputed AND to_jsonb(NEW) - 'disputed' = to_jsonb(OLD) - 'disputed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'challenge_attempts is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER challenge_attempts_append_only BEFORE UPDATE OR DELETE ON public.challenge_attempts
  FOR EACH ROW EXECUTE FUNCTION public.challenge_attempts_append_only();--> statement-breakpoint
CREATE TRIGGER challenge_attempts_no_truncate BEFORE TRUNCATE ON public.challenge_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.challenge_attempts_append_only();--> statement-breakpoint
-- D-1604 backfill: enamed_taxonomy from the matrix_items already in the database (same rule as seed/enamed-taxonomy.ts, which keeps
-- it in sync on `pnpm db:seed`): one `area` row per matrix area (name = the area code; the UI label comes from @remoa/strings);
-- matrix roots -> `domain`; deeper items with children -> `competency`; deeper leaves -> `topic`. Names are the matrix titles.
INSERT INTO public.enamed_taxonomy (code, kind, area, name)
  SELECT DISTINCT m.area::text, 'area', m.area, m.area::text FROM public.matrix_items m
  ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
WITH RECURSIVE tree AS (
  SELECT m.id, m.code, m.title, m.area, m.parent_id, 0 AS depth FROM public.matrix_items m WHERE m.parent_id IS NULL
  UNION ALL
  SELECT c.id, c.code, c.title, c.area, c.parent_id, t.depth + 1 FROM public.matrix_items c JOIN tree t ON c.parent_id = t.id
)
INSERT INTO public.enamed_taxonomy (code, kind, area, name, matrix_ref, parent_id)
  SELECT t.code,
    CASE WHEN t.depth = 0 THEN 'domain' WHEN EXISTS (SELECT 1 FROM public.matrix_items k WHERE k.parent_id = t.id) THEN 'competency' ELSE 'topic' END,
    t.area, t.title, t.id, (SELECT a.id FROM public.enamed_taxonomy a WHERE a.code = t.area::text)
  FROM tree t
  ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
UPDATE public.enamed_taxonomy e SET parent_id = p.id
  FROM public.matrix_items m JOIN public.enamed_taxonomy p ON p.matrix_ref = m.parent_id
  WHERE e.matrix_ref = m.id AND m.parent_id IS NOT NULL;
