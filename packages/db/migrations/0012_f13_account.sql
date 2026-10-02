CREATE TYPE "public"."account_event_type" AS ENUM('email_change_requested', 'email_change_resent', 'email_change_canceled', 'password_changed', 'password_change_failed', 'session_revoked', 'identity_unlinked', 'avatar_changed', 'export_requested', 'deletion_requested', 'deletion_canceled', 'reminder_unsubscribed');--> statement-breakpoint
CREATE TABLE "account_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "account_event_type" NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'light' NOT NULL,
	"reduce_motion" boolean,
	"reminder_enabled" boolean DEFAULT false NOT NULL,
	"reminder_hour" smallint DEFAULT 19 NOT NULL,
	"new_cards_per_day" smallint,
	"email_review_reminders" boolean DEFAULT true NOT NULL,
	"email_product_news" boolean DEFAULT false NOT NULL,
	"reminder_last_sent_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_theme" CHECK ("user_preferences"."theme" in ('light', 'dark', 'system')),
	CONSTRAINT "user_preferences_reminder_hour" CHECK ("user_preferences"."reminder_hour" in (8, 12, 19, 21)),
	CONSTRAINT "user_preferences_new_cards" CHECK ("user_preferences"."new_cards_per_day" between 5 and 20 and "user_preferences"."new_cards_per_day" % 5 = 0)
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "avatar_color" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_events_user_type_idx" ON "account_events" USING btree ("user_id","type","created_at");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_avatar_color" CHECK ("profiles"."avatar_color" between 0 and 4);--> statement-breakpoint
-- Hand-written (F13, D-121): RLS, column GRANTs, updated_at trigger. New tables get Supabase's default GRANT ALL, so start from REVOKE ALL.
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.account_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.user_preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE POLICY user_preferences_select ON public.user_preferences FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY user_preferences_insert ON public.user_preferences FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY user_preferences_update ON public.user_preferences FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());--> statement-breakpoint
REVOKE ALL ON public.user_preferences FROM anon, authenticated;--> statement-breakpoint
-- INSERT is table-wide because drizzle lists every column (as DEFAULT) on insert; a self-set reminder_last_sent_on only skips one's own reminder.
-- UPDATE is per column: reminder_last_sent_on is server-owned (reminder job). new_cards_per_day is capped by the plan at read time (effectiveNewCardsPerDay).
GRANT SELECT, INSERT ON public.user_preferences TO authenticated;--> statement-breakpoint
GRANT UPDATE (theme, reduce_motion, reminder_enabled, reminder_hour, new_cards_per_day, email_review_reminders, email_product_news) ON public.user_preferences TO authenticated;--> statement-breakpoint
-- account_events: audit log and rate-limit counter; the client may read its own rows, only the server connection writes.
CREATE POLICY account_events_select ON public.account_events FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
REVOKE ALL ON public.account_events FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON public.account_events TO authenticated;--> statement-breakpoint
-- profiles: avatar_key stays server-owned (it must point at a processed object of this user); deleted_at stays revoked (0011).
GRANT UPDATE (avatar_color, stage) ON public.profiles TO authenticated;
