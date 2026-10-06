CREATE TABLE "legal_versions" (
	"document" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_versions_document" CHECK (document in ('terms', 'privacy')),
	CONSTRAINT "legal_versions_version" CHECK ("legal_versions"."version" ~ '^[A-Za-z0-9._-]{1,32}$')
);--> statement-breakpoint

ALTER TABLE public.legal_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.legal_versions FROM anon, authenticated;--> statement-breakpoint
-- P-430: handle_new_user records the sign-up acceptance only when both versions equal the current ones in legal_versions
-- (kept by the API at boot from LEGAL_*_VERSION). Empty table (API not booted yet) or any mismatch leaves the columns null:
-- the web then asks via POST /v1/account/legal/accept, same as OAuth sign-ups.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tv text := NEW.raw_user_meta_data ->> 'terms_version';
  pv text := NEW.raw_user_meta_data ->> 'privacy_version';
  valid boolean := coalesce(
    (SELECT version FROM public.legal_versions WHERE document = 'terms') = tv
    AND (SELECT version FROM public.legal_versions WHERE document = 'privacy') = pv, false);
BEGIN
  INSERT INTO public.profiles (user_id, name, terms_accepted_version, privacy_accepted_version, accepted_at)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'name', CASE WHEN valid THEN tv END, CASE WHEN valid THEN pv END, CASE WHEN valid THEN now() END)
  ON CONFLICT DO NOTHING;
  IF valid THEN
    INSERT INTO public.legal_acceptances (user_id, document, version)
    VALUES (NEW.id, 'terms', tv), (NEW.id, 'privacy', pv) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
