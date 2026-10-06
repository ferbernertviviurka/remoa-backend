CREATE TABLE "trial_claims" (
	"email_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_claims_hash" CHECK ("trial_claims"."email_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_trial_user_idx" ON "entitlement_grants" USING btree ("user_id") WHERE "entitlement_grants"."source" = 'trial';--> statement-breakpoint
-- D-1213: trial_claims, server connection only (RLS on, no policy, no grant), like email_suppressions (0022).
ALTER TABLE public.trial_claims ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.trial_claims FROM anon, authenticated;--> statement-breakpoint
-- D-1213: the D-386 hash in SQL, byte for byte the same as emailHash() in apps/api/src/referral/email-normalize.ts
-- (lowercase, trim, no +tag, Gmail without dots, googlemail.com = gmail.com; sha256 hex). trial.test.ts checks both agree.
CREATE OR REPLACE FUNCTION public.remoa_email_hash(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(
    CASE WHEN d IN ('gmail.com', 'googlemail.com') THEN replace(l, '.', '') || '@gmail.com' ELSE l || '@' || d END, 'UTF8')), 'hex')
  FROM (SELECT split_part(split_part(e, '@', 1), '+', 1) AS l, split_part(e, '@', 2) AS d FROM (SELECT lower(btrim(raw)) AS e) x) y
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.remoa_email_hash(text) FROM PUBLIC, anon, authenticated;--> statement-breakpoint
-- D-1213: every new account gets TRIAL_DAYS (15) of Pro once, from sign-up (e-mail or Google), as a `trial` grant. One per address
-- (trial_claims), so a deleted account signing up again with the same e-mail gets none. Never blocks the sign-up: any error in the
-- trial part only skips the trial (warning in the Postgres log). The rest is 0031 unchanged.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tv text := NEW.raw_user_meta_data ->> 'terms_version';
  pv text := NEW.raw_user_meta_data ->> 'privacy_version';
  valid boolean := coalesce(
    (SELECT version FROM public.legal_versions WHERE document = 'terms') = tv
    AND (SELECT version FROM public.legal_versions WHERE document = 'privacy') = pv, false);
  nm text := btrim(left(regexp_replace(btrim(coalesce(
    nullif(btrim(NEW.raw_user_meta_data ->> 'name'), ''), NEW.raw_user_meta_data ->> 'full_name')), '\s+', ' ', 'g'), 60));
BEGIN
  IF nm IS NULL OR length(nm) < 2 OR nm !~ '^[[:alpha:] ''’-]+$' OR nm !~ '[[:alpha:]]' THEN
    nm := NULL;
  END IF;
  INSERT INTO public.profiles (user_id, name, terms_accepted_version, privacy_accepted_version, accepted_at)
  VALUES (NEW.id, nm, CASE WHEN valid THEN tv END, CASE WHEN valid THEN pv END, CASE WHEN valid THEN now() END)
  ON CONFLICT DO NOTHING;
  IF valid THEN
    INSERT INTO public.legal_acceptances (user_id, document, version)
    VALUES (NEW.id, 'terms', tv), (NEW.id, 'privacy', pv) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.email IS NOT NULL THEN
    BEGIN
      INSERT INTO public.trial_claims (email_hash) VALUES (public.remoa_email_hash(NEW.email)) ON CONFLICT DO NOTHING;
      IF FOUND THEN
        INSERT INTO public.entitlement_grants (user_id, source, starts_at, ends_at)
        VALUES (NEW.id, 'trial', now(), now() + interval '15 days') ON CONFLICT DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trial skipped for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- D-1213 (Fernando: existing Free accounts get it too): every live account not paying today (no Founder, no running Pro) gets the
-- 15 days once, from this deploy, queued after any free months it already has. Oldest account wins when two share an address.
WITH eligible AS (
  SELECT DISTINCT ON (public.remoa_email_hash(u.email)) u.id, public.remoa_email_hash(u.email) AS h
  FROM auth.users u
  JOIN public.profiles p ON p.user_id = u.id AND p.deleted_at IS NULL
  LEFT JOIN public.subscriptions s ON s.user_id = u.id
  WHERE u.email IS NOT NULL
    AND coalesce(s.plan::text, 'free') <> 'founder'
    AND NOT coalesce(s.plan = 'pro' AND s.status IN ('active', 'trialing', 'past_due') AND (s.renews_at IS NULL OR s.renews_at > now()), false)
    AND NOT EXISTS (SELECT 1 FROM public.entitlement_grants t WHERE t.user_id = u.id AND t.source = 'trial')
  ORDER BY public.remoa_email_hash(u.email), u.created_at
), claimed AS (
  INSERT INTO public.trial_claims (email_hash) SELECT h FROM eligible ON CONFLICT DO NOTHING RETURNING email_hash
)
INSERT INTO public.entitlement_grants (user_id, source, starts_at, ends_at)
SELECT e.id, 'trial', g.start, g.start + interval '15 days'
FROM eligible e
JOIN claimed c ON c.email_hash = e.h
CROSS JOIN LATERAL (SELECT greatest(now(), (SELECT max(x.ends_at) FROM public.entitlement_grants x WHERE x.user_id = e.id AND x.revoked_at IS NULL)) AS start) g
ON CONFLICT DO NOTHING;
