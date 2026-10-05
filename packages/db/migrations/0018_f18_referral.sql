CREATE TYPE "public"."grant_revoke_reason" AS ENUM('account_deleted', 'fraud', 'manual');--> statement-breakpoint
CREATE TYPE "public"."grant_source" AS ENUM('referral', 'promo', 'support');--> statement-breakpoint
CREATE TYPE "public"."referral_channel" AS ENUM('link', 'email');--> statement-breakpoint
CREATE TYPE "public"."referral_reject_reason" AS ENUM('self_referral', 'disposable_email', 'existing_account', 'velocity_limit', 'fraud_signals', 'manual');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('invited', 'signed_up', 'qualified', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "billing_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"referral_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"stripe_balance_txn_id" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credits_stripe_balance_txn_id_unique" UNIQUE("stripe_balance_txn_id"),
	CONSTRAINT "billing_credits_amount" CHECK ("billing_credits"."amount_cents" > 0),
	CONSTRAINT "billing_credits_currency" CHECK ("billing_credits"."currency" = 'brl'),
	CONSTRAINT "billing_credits_applied" CHECK (("billing_credits"."applied_at" is null) = ("billing_credits"."stripe_balance_txn_id" is null))
);
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "grant_source" NOT NULL,
	"referral_id" uuid,
	"plan" "plan" DEFAULT 'pro' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "grant_revoke_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_grants_range" CHECK ("entitlement_grants"."ends_at" > "entitlement_grants"."starts_at"),
	CONSTRAINT "entitlement_grants_revoked" CHECK (("entitlement_grants"."revoked_at" is null) = ("entitlement_grants"."revoked_reason" is null)),
	CONSTRAINT "entitlement_grants_plan" CHECK ("entitlement_grants"."plan" = 'pro')
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "referral_codes_code" CHECK ("referral_codes"."code" ~ '^[2-9A-HJKMNP-Z]{8}$')
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid,
	"invited_email_hash" text,
	"invited_email_masked" text,
	"channel" "referral_channel" NOT NULL,
	"status" "referral_status" NOT NULL,
	"reject_reason" "referral_reject_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_up_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "referrals_not_self" CHECK ("referrals"."referrer_id" <> "referrals"."referee_id"),
	CONSTRAINT "referrals_email_channel" CHECK ("referrals"."channel" <> 'email' or ("referrals"."invited_email_hash" is not null and "referrals"."invited_email_masked" is not null)),
	CONSTRAINT "referrals_reject_reason" CHECK (("referrals"."status" = 'rejected') = ("referrals"."reject_reason" is not null)),
	CONSTRAINT "referrals_qualified_at" CHECK ("referrals"."status" <> 'qualified' or "referrals"."qualified_at" is not null),
	CONSTRAINT "referrals_signed_up_at" CHECK ("referrals"."status" in ('invited', 'expired') or "referrals"."signed_up_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credits" ADD CONSTRAINT "billing_credits_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_users_id_fk" FOREIGN KEY ("referee_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credits_referral_user_idx" ON "billing_credits" USING btree ("referral_id","user_id");--> statement-breakpoint
CREATE INDEX "billing_credits_user_idx" ON "billing_credits" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_referral_user_idx" ON "entitlement_grants" USING btree ("referral_id","user_id");--> statement-breakpoint
CREATE INDEX "entitlement_grants_user_idx" ON "entitlement_grants" USING btree ("user_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referee_idx" ON "referrals" USING btree ("referee_id") WHERE "referrals"."referee_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referrer_email_idx" ON "referrals" USING btree ("referrer_id","invited_email_hash") WHERE "referrals"."invited_email_hash" is not null;--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id","created_at");--> statement-breakpoint
CREATE INDEX "referrals_pending_idx" ON "referrals" USING btree ("status","expires_at") WHERE "referrals"."status" in ('invited', 'signed_up');--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_referred_by_users_id_fk" FOREIGN KEY ("referred_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written (F18, D-387): every F18 table is server-written (service role / server connection). New tables get Supabase's
-- default GRANT ALL, so start from REVOKE ALL. profiles.referred_by gets no column GRANT (profiles UPDATE is per column, 0001/0012).
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.entitlement_grants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.billing_credits ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.referral_codes, public.referrals, public.entitlement_grants, public.billing_credits FROM anon, authenticated;--> statement-breakpoint
CREATE POLICY referral_codes_select ON public.referral_codes FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY entitlement_grants_select ON public.entitlement_grants FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
CREATE POLICY billing_credits_select ON public.billing_credits FOR SELECT TO authenticated USING (user_id = auth.uid());--> statement-breakpoint
GRANT SELECT ON public.referral_codes, public.entitlement_grants, public.billing_credits TO authenticated;--> statement-breakpoint
-- referrals: no policy, no grant. The referrer reads their friends only through referral_friends() (masked, no e-mail hash,
-- no referee id, no reject reason); the server connection reads the table for qualification and antifraud.
-- "Daniel Souza Lima" -> "Daniel L."; "Daniel" -> "Daniel"; blank/null -> null.
CREATE FUNCTION public.referral_display_name(full_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n IS NULL OR n = '' THEN NULL
    WHEN position(' ' IN n) = 0 THEN left(n, 40)
    ELSE left(split_part(n, ' ', 1), 40) || ' ' || upper(left(regexp_replace(n, '^.* ', ''), 1)) || '.'
  END
  FROM (SELECT regexp_replace(btrim(full_name), '\s+', ' ', 'g') AS n) s
$$;--> statement-breakpoint
-- D-385: rejected shows as signed_up (antifraud is never revealed), expired is hidden. removed = referee account deleted
-- (hard: referee_id set null by the FK; soft: profiles.deleted_at during the 7-day grace).
CREATE FUNCTION public.referral_friends() RETURNS TABLE (
  id uuid, display_name text, removed boolean, status text, invited_at timestamptz, signed_up_at timestamptz, qualified_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id,
    CASE
      WHEN r.status = 'invited' THEN r.invited_email_masked
      WHEN r.referee_id IS NULL OR p.deleted_at IS NOT NULL THEN NULL
      ELSE public.referral_display_name(p.name)
    END,
    r.status <> 'invited' AND (r.referee_id IS NULL OR p.deleted_at IS NOT NULL),
    CASE WHEN r.status = 'rejected' THEN 'signed_up' ELSE r.status::text END,
    CASE WHEN r.channel = 'email' THEN r.created_at END,
    r.signed_up_at,
    r.qualified_at
  FROM public.referrals r
  LEFT JOIN public.profiles p ON p.user_id = r.referee_id
  WHERE r.referrer_id = auth.uid() AND r.status <> 'expired'
  ORDER BY coalesce(r.qualified_at, r.signed_up_at, r.created_at) DESC
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.referral_friends() FROM public, anon;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.referral_friends() TO authenticated;
