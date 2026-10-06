ALTER TABLE "profiles" ADD COLUMN "school_id" text;--> statement-breakpoint
-- G20 CCR-050 (D-843/D-845): school_id gets no column GRANT (server-owned, like phone, 0024). name and school lose theirs (0001):
-- the API is now their only writer (PATCH /v1/account/profile: name required and never cleared; school + school_id written
-- together from `institution`), so a direct PostgREST update cannot clear the name or split school from school_id.
REVOKE UPDATE (name, school) ON public.profiles FROM authenticated;--> statement-breakpoint
-- G20 (D-846): the profile name comes from `name` (e-mail sign-up) or `full_name` (Google), normalized like nameSchema
-- (trim, collapse spaces, at most 60 chars; letters, space, hyphen, apostrophe). Anything else is stored as null instead of failing
-- the sign-up; the web then asks it in "Conte quem você é" (missingRequiredProfile). The legal acceptance part is unchanged from
-- 0030 (P-430/D-963): recorded only when both versions equal the current ones in legal_versions.
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
  RETURN NEW;
END $$;
