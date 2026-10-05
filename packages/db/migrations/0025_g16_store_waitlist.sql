CREATE TABLE "store_waitlist" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"wants_buy" boolean DEFAULT false NOT NULL,
	"wants_sell" boolean DEFAULT false NOT NULL,
	"seller_role" text,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_waitlist_interest" CHECK ("store_waitlist"."wants_buy" or "store_waitlist"."wants_sell"),
	CONSTRAINT "store_waitlist_role" CHECK (("store_waitlist"."wants_sell" and "store_waitlist"."seller_role" in ('teacher', 'student_resident', 'physician')) or (not "store_waitlist"."wants_sell" and "store_waitlist"."seller_role" is null)),
	CONSTRAINT "store_waitlist_email" CHECK (char_length("store_waitlist"."email") between 3 and 254)
);
--> statement-breakpoint
ALTER TABLE "store_waitlist" ADD CONSTRAINT "store_waitlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_waitlist_created_idx" ON "store_waitlist" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written (G16, CCR-030, D-651): RLS on, own row readable, written only by the API connection (as F18/F19).
ALTER TABLE public.store_waitlist ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.store_waitlist FROM anon, authenticated;--> statement-breakpoint
CREATE POLICY store_waitlist_select ON public.store_waitlist FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT ON public.store_waitlist TO authenticated;
