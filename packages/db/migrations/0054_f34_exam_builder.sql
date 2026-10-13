CREATE TABLE "exam_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_templates_owner_name_uq" UNIQUE("user_id","name"),
	CONSTRAINT "exam_templates_name_chk" CHECK (char_length(btrim("exam_templates"."name")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "exam_templates" ADD CONSTRAINT "exam_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_templates_owner_created_idx" ON "exam_templates" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "question_sessions_one_active_builder_uq" ON "question_sessions" USING btree ("user_id") WHERE "question_sessions"."status" = 'active' and "question_sessions"."config" ? 'builder';--> statement-breakpoint
-- F34 (CCR-147, D-1829): owner-only read; inserts/updates/deletes go through the API (server role, plan limit checked there).
ALTER TABLE public.exam_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.exam_templates FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE POLICY exam_templates_owner ON public.exam_templates FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
--> statement-breakpoint
GRANT SELECT ON public.exam_templates TO authenticated;
