CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."email_template" AS ENUM('account-confirm', 'purchase-success', 'password-reset', 'calendar-reminder', 'inactivity', 'review-reminder', 'map-ready', 'waitlist-confirm');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('calendar', 'review', 'maps', 'referrals', 'support', 'account_billing', 'store');--> statement-breakpoint
CREATE TYPE "public"."notification_pref_key" AS ENUM('calendar_d1', 'calendar_d0', 'review_reminder', 'map_ready', 'inactivity', 'referral', 'support', 'account_billing', 'store');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('calendar_d1', 'calendar_d0', 'calendar_digest', 'review_reminder', 'map_ready', 'referral_reward', 'support_reply', 'purchase', 'waitlist_joined', 'inactivity', 'account', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."calendar_color" AS ENUM('orange', 'amber', 'purple', 'teal', 'gray', 'blue', 'pink', 'green');--> statement-breakpoint
CREATE TYPE "public"."calendar_reminder_kind" AS ENUM('d1', 'd0');--> statement-breakpoint
CREATE TYPE "public"."calendar_reminder_status" AS ENUM('scheduled', 'sent', 'skipped', 'canceled');--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"template" "email_template" NOT NULL,
	"reference" text NOT NULL,
	"to_hash" text NOT NULL,
	"provider_id" text,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" text,
	"redirected" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_to_hash" CHECK ("email_deliveries"."to_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_deliveries_reference" CHECK (char_length("email_deliveries"."reference") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"key" "notification_pref_key" NOT NULL,
	"in_app" boolean NOT NULL,
	"email" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "notification_preferences_fixed_email" CHECK ("notification_preferences"."email" or "notification_preferences"."key" not in ('support', 'account_billing'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"category" "notification_category" NOT NULL,
	"href" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_key" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "notifications_href" CHECK ("notifications"."href" is null or "notifications"."href" like '/%')
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"label_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"timezone" text NOT NULL,
	"location" text,
	"description" text,
	"cover_asset_id" uuid,
	"remind_d1" boolean DEFAULT true NOT NULL,
	"remind_d0" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_title" CHECK (char_length("calendar_events"."title") between 2 and 120),
	CONSTRAINT "calendar_events_location" CHECK (char_length("calendar_events"."location") <= 160),
	CONSTRAINT "calendar_events_description" CHECK (char_length("calendar_events"."description") <= 2000),
	CONSTRAINT "calendar_events_ends" CHECK ("calendar_events"."ends_at" is null or "calendar_events"."ends_at" >= "calendar_events"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "calendar_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" "calendar_color" NOT NULL,
	"system_key" text,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_labels_name" CHECK (char_length("calendar_labels"."name") between 2 and 40),
	CONSTRAINT "calendar_labels_system_key" CHECK (system_key in ('exam', 'assignment', 'important_date', 'shift', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "calendar_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "calendar_reminder_kind" NOT NULL,
	"occurrence_date" date NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" "calendar_reminder_status" DEFAULT 'scheduled' NOT NULL,
	"notification_id" uuid,
	"email_delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_reminder_hour";--> statement-breakpoint
-- D-744: review reminder times are now 07, 08, 12, 20 (F26 FR-6); 19 and 21 move to the nearest, 20.
UPDATE "user_preferences" SET "reminder_hour" = 20 WHERE "reminder_hour" in (19, 21);--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "reminder_hour" SET DEFAULT 20;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "notif_pause_reminders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "calendar_tour_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "calendar_view" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "calendar_hidden_labels" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD COLUMN "reason" text DEFAULT 'invite_opt_out' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_label_id_calendar_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."calendar_labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_labels" ADD CONSTRAINT "calendar_labels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminders" ADD CONSTRAINT "calendar_reminders_email_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("email_delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_idempotency_idx" ON "email_deliveries" USING btree ("template","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_provider_idx" ON "email_deliveries" USING btree ("provider_id") WHERE "email_deliveries"."provider_id" is not null;--> statement-breakpoint
CREATE INDEX "email_deliveries_user_idx" ON "email_deliveries" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_deliveries_template_idx" ON "email_deliveries" USING btree ("template","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idempotency_idx" ON "notifications" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null and "notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "calendar_events_user_starts_idx" ON "calendar_events" USING btree ("user_id","starts_at") WHERE "calendar_events"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "calendar_events_label_idx" ON "calendar_events" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "calendar_events_deleted_idx" ON "calendar_events" USING btree ("deleted_at") WHERE "calendar_events"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "calendar_labels_user_idx" ON "calendar_labels" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_labels_system_idx" ON "calendar_labels" USING btree ("user_id","system_key") WHERE "calendar_labels"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_reminders_occurrence_idx" ON "calendar_reminders" USING btree ("event_id","kind","occurrence_date");--> statement-breakpoint
CREATE INDEX "calendar_reminders_due_idx" ON "calendar_reminders" USING btree ("send_at") WHERE "calendar_reminders"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "calendar_reminders_user_idx" ON "calendar_reminders" USING btree ("user_id","send_at");--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_calendar_view" CHECK (calendar_view in ('month', 'week', 'agenda', 'gallery'));--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_reminder_hour" CHECK ("user_preferences"."reminder_hour" in (7, 8, 12, 20));--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_reason" CHECK (reason in ('invite_opt_out', 'hard_bounce', 'complaint'));;--> statement-breakpoint
-- Hand-written (G18, CCR-034, D-736–D-744): RLS, grants, triggers, backfill, Realtime. New tables get Supabase's default GRANT ALL, so start from REVOKE ALL.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.email_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar_labels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calendar_reminders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.notifications, public.notification_preferences, public.email_deliveries, public.calendar_labels, public.calendar_events, public.calendar_reminders FROM anon, authenticated;--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.email_deliveries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.calendar_labels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.calendar_reminders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- notifications: written only by notify() (server connection); the owner reads (and gets Realtime) and may mark read / dismiss.
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY notifications_update ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT ON public.notifications TO authenticated;--> statement-breakpoint
GRANT UPDATE (read_at, dismissed_at) ON public.notifications TO authenticated;--> statement-breakpoint
-- notification_preferences: owner rows; the CHECK keeps the fixed e-mails (support, account_billing) on whoever writes.
CREATE POLICY notification_preferences_select ON public.notification_preferences FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY notification_preferences_insert ON public.notification_preferences FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY notification_preferences_update ON public.notification_preferences FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT, INSERT ON public.notification_preferences TO authenticated;--> statement-breakpoint
GRANT UPDATE (in_app, email) ON public.notification_preferences TO authenticated;--> statement-breakpoint
-- email_deliveries: server connection only (RLS on, no policy, no grant), like email_suppressions. Admin reads go through withAdmin.
-- calendar_labels: owner CRUD; `personal` cannot be deleted (deleting another label moves its events to it, in the API).
CREATE POLICY calendar_labels_select ON public.calendar_labels FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY calendar_labels_insert ON public.calendar_labels FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY calendar_labels_update ON public.calendar_labels FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY calendar_labels_delete ON public.calendar_labels FOR DELETE TO authenticated USING (user_id = auth.uid() AND system_key IS DISTINCT FROM 'personal');--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.calendar_labels TO authenticated;--> statement-breakpoint
GRANT UPDATE (name, color, position) ON public.calendar_labels TO authenticated;--> statement-breakpoint
-- calendar_events: owner reads/writes; the label and the cover must be the owner's own (a card asset someone shared is not).
-- No DELETE grant: deletion is soft (deleted_at); calendar.cleanup purges with the server connection.
CREATE POLICY calendar_events_select ON public.calendar_events FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY calendar_events_insert ON public.calendar_events FOR INSERT TO authenticated WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.calendar_labels l WHERE l.id = label_id AND l.user_id = auth.uid())
  AND (cover_asset_id IS NULL OR EXISTS (SELECT 1 FROM public.assets a WHERE a.id = cover_asset_id AND a.user_id = auth.uid())));--> statement-breakpoint
CREATE POLICY calendar_events_update ON public.calendar_events FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.calendar_labels l WHERE l.id = label_id AND l.user_id = auth.uid())
  AND (cover_asset_id IS NULL OR EXISTS (SELECT 1 FROM public.assets a WHERE a.id = cover_asset_id AND a.user_id = auth.uid())));--> statement-breakpoint
GRANT SELECT, INSERT ON public.calendar_events TO authenticated;--> statement-breakpoint
GRANT UPDATE (title, label_id, starts_at, ends_at, all_day, timezone, location, description, cover_asset_id, remind_d1, remind_d0, deleted_at) ON public.calendar_events TO authenticated;--> statement-breakpoint
-- calendar_reminders: planned and dispatched by the server only; the owner reads them (drawer shows the send time).
CREATE POLICY calendar_reminders_select ON public.calendar_reminders FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT ON public.calendar_reminders TO authenticated;--> statement-breakpoint
-- user_preferences: the new F25/F26 columns are the owner's choices.
GRANT UPDATE (notif_pause_reminders, calendar_tour_seen_at, calendar_view, calendar_hidden_labels) ON public.user_preferences TO authenticated;--> statement-breakpoint
-- D-743 backfill: F13 opt-ins to the daily reminder e-mail become the review_reminder row (one source of truth from now on).
INSERT INTO public.notification_preferences (user_id, key, in_app, email)
  SELECT user_id, 'review_reminder', true, true FROM public.user_preferences WHERE reminder_enabled AND email_review_reminders
  ON CONFLICT DO NOTHING;--> statement-breakpoint
-- F26 FR-9: Realtime for the bell. Idempotent, and a no-op where the publication does not exist (plain Postgres in CI).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
