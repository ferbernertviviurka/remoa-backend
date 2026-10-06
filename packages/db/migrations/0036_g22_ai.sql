CREATE TABLE "ai_grade_flags" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"input" jsonb NOT NULL,
	"text" text,
	"input_hash" text NOT NULL,
	"board_id" uuid,
	"error" text,
	"ai" jsonb,
	"stats" jsonb,
	"charged" boolean DEFAULT false NOT NULL,
	"quota_period" date,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD COLUMN "ai_rubrics" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_grade_flags" ADD CONSTRAINT "ai_grade_flags_call_id_ai_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."ai_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_grade_flags" ADD CONSTRAINT "ai_grade_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_jobs_user_hash_idx" ON "ai_jobs" USING btree ("user_id","input_hash");--> statement-breakpoint
-- G22 (D-1415/D-1416): RLS by hand. ai_jobs: the owner reads; writes only with the server connection (like ai_calls).
ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ai_jobs_select ON public.ai_jobs FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.ai_jobs FROM authenticated, anon;--> statement-breakpoint
-- ai_grade_flags: the owner reads and flags their own graded call (insert only; a flag is never edited or removed by the user).
ALTER TABLE public.ai_grade_flags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ai_grade_flags_select ON public.ai_grade_flags FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
CREATE POLICY ai_grade_flags_insert ON public.ai_grade_flags FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()) AND EXISTS (SELECT 1 FROM public.ai_calls c WHERE c.id = call_id AND c.user_id = (select auth.uid()) AND c.kind = 'grade'));--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.ai_grade_flags FROM authenticated, anon;--> statement-breakpoint
REVOKE INSERT ON public.ai_grade_flags FROM anon;
