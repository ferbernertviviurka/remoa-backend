CREATE TYPE "public"."board_access" AS ENUM('owner', 'password', 'public');--> statement-breakpoint
ALTER TYPE "public"."area" ADD VALUE 'CIR';--> statement-breakpoint
ALTER TYPE "public"."area" ADD VALUE 'GO';--> statement-breakpoint
ALTER TYPE "public"."area" ADD VALUE 'PED';--> statement-breakpoint
ALTER TYPE "public"."area" ADD VALUE 'MP';--> statement-breakpoint
CREATE TABLE "share_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "access" "board_access" DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "share_password_hash" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "share_secret_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "copy_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "copied_from_link_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "share_attempts_lookup_idx" ON "share_attempts" USING btree ("token_hash","ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_token_unique" UNIQUE("share_token");--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_token_chk" CHECK (("boards"."access" = 'owner') = ("boards"."share_token" is null));--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_password_chk" CHECK (("boards"."access" = 'password') = ("boards"."share_password_hash" is not null));--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_private_chk" CHECK ("boards"."access" = 'owner' or "boards"."status" = 'private');--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_share_counters_chk" CHECK ("boards"."share_secret_version" >= 1 and "boards"."copy_count" >= 0);--> statement-breakpoint
-- Hand-written (F17, D-288): share state is server-owned. UPDATE becomes per column so the client (PostgREST or withUser)
-- cannot set access, token, hash, version or counters; INSERT stays table-wide because drizzle lists every column.
-- New boards columns that the client may update must be added to this GRANT.
REVOKE UPDATE ON public.boards FROM anon, authenticated;--> statement-breakpoint
GRANT UPDATE (id, user_id, title, area, matrix_item_id, status, version, temporal_mark, reviewer_id, source_board_id, archived_at, created_at, updated_at) ON public.boards TO authenticated;--> statement-breakpoint
-- share_attempts: unlock limiter, server connection only (RLS on, no policy, no grant).
ALTER TABLE public.share_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.share_attempts FROM anon, authenticated;
