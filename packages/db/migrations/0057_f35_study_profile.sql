-- G28-P / F35 (CCR-160, CCR-161 adds waitlist.course): study profile, health-area reference data, light audit, curation queue; backfill of existing accounts.
-- Down (manual, in this order; db/src/rls-f35.test.ts runs the lines between the markers):
-- DOWN-BEGIN
-- DROP TABLE IF EXISTS public.study_profile_audit, public.study_profiles, public.reference_suggestions, public.study_goals, public.health_courses, public.institutions, public.councils;
-- DROP FUNCTION IF EXISTS public.study_profile_audit_fn();
-- ALTER TABLE public.waitlist DROP CONSTRAINT IF EXISTS waitlist_course; ALTER TABLE public.waitlist DROP COLUMN IF EXISTS course;
-- DOWN-END
-- then: DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791935933984;
CREATE TABLE "councils" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "councils_code" CHECK (code in ('CRM', 'COREN', 'CRO', 'CRF', 'CREFITO', 'CRN', 'CRP', 'CRBM', 'CREFONO', 'CREF', 'CRESS', 'CRMV', 'CRBio', 'CRTR'))
);
--> statement-breakpoint
CREATE TABLE "health_courses" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"kind" text NOT NULL,
	"council_code" text,
	"suggested_goals" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "health_courses_code" CHECK (code in ('medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy', 'biomedicine', 'nutrition', 'speech_therapy', 'physical_education', 'veterinary_medicine', 'occupational_therapy', 'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health')),
	CONSTRAINT "health_courses_kind" CHECK (kind in ('course', 'other_health', 'not_health')),
	CONSTRAINT "health_courses_goals" CHECK (suggested_goals <@ array['enamed', 'residencia_medica', 'revalida', 'provas_faculdade', 'provas_curso', 'concursos_saude', 'residencia_multiprofissional', 'residencia_enfermagem', 'residencia_especializacao', 'enade', 'atualizacao_profissional', 'idiomas', 'aprender_por_conta']::text[])
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emec_code" integer NOT NULL,
	"name" text NOT NULL,
	"acronym" text,
	"city" text NOT NULL,
	"uf" text NOT NULL,
	"type" text NOT NULL,
	"search" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_emec_code_unique" UNIQUE("emec_code"),
	CONSTRAINT "institutions_uf" CHECK (uf in ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO')),
	CONSTRAINT "institutions_type" CHECK (type in ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "reference_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"normalized" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_suggestions_kind_normalized_uq" UNIQUE("kind","normalized"),
	CONSTRAINT "reference_suggestions_kind" CHECK (kind in ('course', 'institution', 'goal')),
	CONSTRAINT "reference_suggestions_status" CHECK (status in ('pending', 'accepted', 'rejected')),
	CONSTRAINT "reference_suggestions_text" CHECK (char_length(text) between 2 and 160)
);
--> statement-breakpoint
CREATE TABLE "study_goals" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"course_codes" text[],
	"sort" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "study_goals_code" CHECK (code in ('enamed', 'residencia_medica', 'revalida', 'provas_faculdade', 'provas_curso', 'concursos_saude', 'residencia_multiprofissional', 'residencia_enfermagem', 'residencia_especializacao', 'enade', 'atualizacao_profissional', 'idiomas', 'aprender_por_conta')),
	CONSTRAINT "study_goals_courses" CHECK (course_codes is null or course_codes <@ array['medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy', 'biomedicine', 'nutrition', 'speech_therapy', 'physical_education', 'veterinary_medicine', 'occupational_therapy', 'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health']::text[])
);
--> statement-breakpoint
CREATE TABLE "study_profile_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid,
	"fields" text[] NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"situation" text,
	"course_code" text,
	"course_other_text" text,
	"institution_id" uuid,
	"institution_text" text,
	"city" text,
	"uf" text,
	"institution_type" text,
	"period" smallint,
	"goals" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_goals" text[] DEFAULT '{}'::text[] NOT NULL,
	"council_number" text,
	"non_health_topic" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_profiles_source" CHECK (source in ('signup', 'profile', 'migration')),
	CONSTRAINT "study_profiles_situation" CHECK (situation is null or situation in ('graduacao', 'residente', 'profissional', 'preparando')),
	CONSTRAINT "study_profiles_course" CHECK (course_code is null or course_code in ('medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy', 'biomedicine', 'nutrition', 'speech_therapy', 'physical_education', 'veterinary_medicine', 'occupational_therapy', 'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health')),
	CONSTRAINT "study_profiles_uf" CHECK (uf is null or uf in ('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO')),
	CONSTRAINT "study_profiles_institution_type" CHECK (institution_type is null or institution_type in ('public', 'private')),
	CONSTRAINT "study_profiles_goals" CHECK (goals <@ array['enamed', 'residencia_medica', 'revalida', 'provas_faculdade', 'provas_curso', 'concursos_saude', 'residencia_multiprofissional', 'residencia_enfermagem', 'residencia_especializacao', 'enade', 'atualizacao_profissional', 'idiomas', 'aprender_por_conta']::text[] and cardinality(goals) <= 5),
	CONSTRAINT "study_profiles_custom_goals" CHECK (cardinality(custom_goals) <= 3),
	CONSTRAINT "study_profiles_complete" CHECK (source = 'migration' or (course_code is not null and situation is not null and cardinality(goals) + cardinality(custom_goals) >= 1)),
	CONSTRAINT "study_profiles_period" CHECK (period is null or (period between 1 and 12 and situation = 'graduacao' and course_code <> 'not_health')),
	CONSTRAINT "study_profiles_council" CHECK (council_number is null or (situation = 'profissional' and char_length(council_number) between 1 and 20)),
	CONSTRAINT "study_profiles_other" CHECK ((coalesce(course_code, '') = 'other_health') = (course_other_text is not null)),
	CONSTRAINT "study_profiles_non_health" CHECK ((coalesce(course_code, '') = 'not_health') = (non_health_topic is not null)),
	CONSTRAINT "study_profiles_institution" CHECK (institution_id is null or institution_text is null),
	CONSTRAINT "study_profiles_lengths" CHECK ((course_other_text is null or char_length(course_other_text) between 1 and 80) and (institution_text is null or char_length(institution_text) between 1 and 160) and (city is null or char_length(city) between 1 and 80) and (non_health_topic is null or char_length(non_health_topic) between 1 and 80))
);
--> statement-breakpoint
ALTER TABLE "health_courses" ADD CONSTRAINT "health_courses_council_code_councils_code_fk" FOREIGN KEY ("council_code") REFERENCES "public"."councils"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_profile_audit" ADD CONSTRAINT "study_profile_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_profiles" ADD CONSTRAINT "study_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_profiles" ADD CONSTRAINT "study_profiles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "institutions_search_trgm_idx" ON "institutions" USING gin ("search" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "study_profile_audit_user_at_idx" ON "study_profile_audit" USING btree ("user_id","at");--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "course" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_course" CHECK (course is null or course in ('medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy', 'biomedicine', 'nutrition', 'speech_therapy', 'physical_education', 'veterinary_medicine', 'occupational_therapy', 'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health'));
--> statement-breakpoint
-- FR-45/FR-47 (D-1855, D-1856): every existing account gets a 'migration' row, course and situation NOT inferred; goal 'enamed'
-- preselected only when the old exam objective (profiles.goals / goal) was an Enamed edition. Runs before the audit trigger exists.
INSERT INTO public.study_profiles (user_id, source, goals)
SELECT p.user_id, 'migration',
  CASE WHEN EXISTS (SELECT 1 FROM unnest(array_append(p.goals, p.goal)) g WHERE g LIKE 'enamed\_%') THEN '{enamed}'::text[] ELSE '{}'::text[] END
FROM public.profiles p
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
-- FR-25 light audit (field names only) + users never (re)enter 'migration'. Any writer path (API or PostgREST) is covered.
CREATE FUNCTION public.study_profile_audit_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f text[];
BEGIN
  IF NEW.source = 'migration' AND auth.uid() IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.source <> 'migration') THEN
    RAISE EXCEPTION 'study_profiles: source migration is server-only' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO f FROM jsonb_each(to_jsonb(NEW)) n
    WHERE n.key NOT IN ('user_id', 'created_at', 'updated_at')
      AND CASE WHEN TG_OP = 'INSERT' THEN n.value NOT IN ('null'::jsonb, '[]'::jsonb) ELSE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key END;
  IF cardinality(f) > 0 THEN
    INSERT INTO public.study_profile_audit (user_id, actor_id, fields) VALUES (NEW.user_id, auth.uid(), f);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.study_profile_audit_fn() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER study_profiles_audit BEFORE INSERT OR UPDATE ON public.study_profiles FOR EACH ROW EXECUTE FUNCTION public.study_profile_audit_fn();
--> statement-breakpoint
-- RLS: study_profiles owner-only read/insert/update (no delete: goes with the account). council_number is private by the same rule.
ALTER TABLE public.study_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.study_profiles FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE POLICY study_profiles_select ON public.study_profiles FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
CREATE POLICY study_profiles_insert ON public.study_profiles FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));
--> statement-breakpoint
CREATE POLICY study_profiles_update ON public.study_profiles FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.study_profiles TO authenticated;
--> statement-breakpoint
-- Reference data: readable by authenticated, written only by the server (seed loader, curation).
ALTER TABLE public.councils ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.health_courses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.study_goals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.councils, public.health_courses, public.study_goals, public.institutions FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE POLICY councils_read ON public.councils FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY health_courses_read ON public.health_courses FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY study_goals_read ON public.study_goals FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY institutions_read ON public.institutions FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
GRANT SELECT ON public.councils, public.health_courses, public.study_goals, public.institutions TO authenticated;
--> statement-breakpoint
-- Server-only: audit and the curation queue (no policy, no grant).
ALTER TABLE public.study_profile_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.reference_suggestions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.study_profile_audit, public.reference_suggestions FROM PUBLIC, anon, authenticated;
