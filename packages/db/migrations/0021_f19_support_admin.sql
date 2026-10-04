CREATE TYPE "public"."support_author_type" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('open', 'in_review', 'answered', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_type" AS ENUM('bug', 'billing', 'content', 'suggestion', 'other');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('admin', 'user', 'system', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'denied');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('paid', 'pending', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE "support_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"key" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachments_key_unique" UNIQUE("key"),
	CONSTRAINT "support_attachments_mime" CHECK ("support_attachments"."mime" in ('image/png', 'image/jpeg')),
	CONSTRAINT "support_attachments_size" CHECK ("support_attachments"."size" between 1 and 5242880)
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" "support_author_type" NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_body" CHECK (char_length("support_messages"."body") between 1 and 5000),
	CONSTRAINT "support_messages_internal" CHECK (not "support_messages"."internal" or "support_messages"."author_type" = 'admin')
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "support_tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"user_id" uuid NOT NULL,
	"type" "support_ticket_type" NOT NULL,
	"subject" text NOT NULL,
	"status" "support_ticket_status" DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"context" jsonb,
	"last_user_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_admin_reply_at" timestamp with time zone,
	"last_user_read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "support_tickets_subject" CHECK (char_length("support_tickets"."subject") between 5 and 120),
	CONSTRAINT "support_tickets_resolved" CHECK (("support_tickets"."status" = 'resolved') = ("support_tickets"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1),
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"result" "audit_result" NOT NULL,
	"denial" text,
	"before" jsonb,
	"after" jsonb,
	"ip_hash" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_log_denial" CHECK (("admin_audit_log"."result" = 'denied') = ("admin_audit_log"."denial" is not null)),
	CONSTRAINT "admin_audit_log_reason" CHECK ("admin_audit_log"."actor_type" <> 'admin' or "admin_audit_log"."result" <> 'success' or char_length(btrim("admin_audit_log"."reason")) >= 8)
);
--> statement-breakpoint
CREATE TABLE "admin_metrics_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"new_accounts" integer DEFAULT 0 NOT NULL,
	"new_maps" integer DEFAULT 0 NOT NULL,
	"new_pro" integer DEFAULT 0 NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL,
	"referrals_qualified" integer DEFAULT 0 NOT NULL,
	"tickets_opened" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_payment_intent" text,
	"stripe_invoice_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"method" text NOT NULL,
	"status" "payment_status" NOT NULL,
	"item" text NOT NULL,
	"coupon" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount" CHECK ("payments"."amount_cents" >= 0),
	CONSTRAINT "payments_method" CHECK ("payments"."method" in ('pix', 'card', 'credit')),
	CONSTRAINT "payments_refunded" CHECK (("payments"."status" = 'refunded') = ("payments"."refunded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_support_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_attachments_message_idx" ON "support_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "support_attachments_ticket_idx" ON "support_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "support_messages_ticket_idx" ON "support_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","last_user_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_subject_trgm_idx" ON "support_tickets" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_idx" ON "admin_audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_idx" ON "admin_audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "boards_title_trgm_idx" ON "boards" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "boards_created_idx" ON "boards" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profiles_name_trgm_idx" ON "profiles" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_suspended" CHECK (("profiles"."suspended_at" is null) = ("profiles"."suspended_reason" is null));--> statement-breakpoint
-- Hand-written (F19, CCR-011, D-427/D-429). Every F19 table is written only by the server connection (as in F18, D-387):
-- new tables get Supabase's default GRANT ALL, so start from REVOKE ALL. profiles.suspended_* get no column GRANT
-- (profiles UPDATE is per column, 0001/0012), so only the server sets them.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.support_attachments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.admin_metrics_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.support_tickets, public.support_messages, public.support_attachments, public.payments,
  public.admin_audit_log, public.admin_metrics_daily FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON SEQUENCE public.support_tickets_number_seq, public.admin_audit_log_id_seq FROM anon, authenticated;--> statement-breakpoint
-- Support: the user reads own tickets, the non-internal messages of them and their attachments. No column for who the
-- assigned admin is, nor which admin wrote a message.
CREATE POLICY support_tickets_select ON public.support_tickets FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT (id, number, user_id, type, subject, status, context, last_user_message_at, last_admin_reply_at, last_user_read_at,
  resolved_at, created_at, updated_at) ON public.support_tickets TO authenticated;--> statement-breakpoint
CREATE POLICY support_messages_select ON public.support_messages FOR SELECT TO authenticated USING (
  NOT internal AND EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_id AND t.user_id = auth.uid())
);--> statement-breakpoint
GRANT SELECT (id, ticket_id, author_type, body, internal, created_at) ON public.support_messages TO authenticated;--> statement-breakpoint
CREATE POLICY support_attachments_select ON public.support_attachments FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.support_messages m JOIN public.support_tickets t ON t.id = m.ticket_id
    WHERE m.id = message_id AND NOT m.internal AND t.user_id = auth.uid()
  )
);--> statement-breakpoint
GRANT SELECT ON public.support_attachments TO authenticated;--> statement-breakpoint
-- payments, admin_audit_log, admin_metrics_daily: no policy, no grant (server only).
-- admin_audit_log is append-only for everyone, server connection included (FR-19, D-429). Retention (Q-051) will need
-- an explicit migration that drops and recreates these triggers.
CREATE FUNCTION public.admin_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER admin_audit_log_no_update_delete BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();--> statement-breakpoint
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON public.admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_log_append_only();
