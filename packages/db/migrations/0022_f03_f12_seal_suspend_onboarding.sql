CREATE TABLE "email_suppressions" (
	"email_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_hash" CHECK ("email_suppressions"."email_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "onboarding_answers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Hand-written (CCR-015). P-004 / rule 6 (D-490): the review seal is server-owned. Client roles (PostgREST with a user JWT,
-- or the API's withUser(), which runs as `authenticated`) can't forge cards.status/reviewer_id/rubric nor boards.status/
-- reviewer_id/temporal_mark. The API's own connection (postgres/service_role) is untouched: editorial, AI rubric, seed copy.
-- Triggers instead of column GRANTs because drizzle INSERTs list every column (DEFAULT included), and INSERT privilege is per listed column.
CREATE FUNCTION public.unsealed_rubric(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(r) = 'object'
    THEN (r - 'reviewerName' - 'reviewerCrm') || '{"status":"draft","reviewerId":null}'::jsonb ELSE r END
$$;--> statement-breakpoint
CREATE FUNCTION public.cards_guard_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    -- a student's copy (duplicate, shared-link copy, import) never carries a seal: coerced, not refused, so copies keep working
    NEW.status := 'draft'; NEW.reviewer_id := NULL; NEW.rubric := public.unsealed_rubric(NEW.rubric);
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.rubric IS DISTINCT FROM OLD.rubric THEN
    RAISE EXCEPTION 'cards.status/reviewer_id/rubric are server-owned' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- editing reviewed content drops the seal: what the reviewer approved is no longer what is shown
  IF (OLD.status = 'approved' OR OLD.rubric ->> 'status' = 'approved')
     AND (NEW.title, NEW.front, NEW.back, NEW.payload, NEW.type, NEW.front_asset_id, NEW.back_asset_id)
       IS DISTINCT FROM (OLD.title, OLD.front, OLD.back, OLD.payload, OLD.type, OLD.front_asset_id, OLD.back_asset_id) THEN
    NEW.status := 'draft'; NEW.reviewer_id := NULL; NEW.rubric := public.unsealed_rubric(NEW.rubric);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER cards_guard_seal BEFORE INSERT OR UPDATE ON public.cards FOR EACH ROW EXECUTE FUNCTION public.cards_guard_seal();--> statement-breakpoint
CREATE FUNCTION public.boards_guard_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  -- reviewers too: publishing goes through the API (name + CRM, board_versions), never straight to the table
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'private' OR NEW.reviewer_id IS NOT NULL OR NEW.temporal_mark IS NOT NULL THEN
      RAISE EXCEPTION 'boards.status/reviewer_id/temporal_mark are server-owned' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.temporal_mark IS DISTINCT FROM OLD.temporal_mark THEN
    RAISE EXCEPTION 'boards.status/reviewer_id/temporal_mark are server-owned' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER boards_guard_seal BEFORE INSERT OR UPDATE ON public.boards FOR EACH ROW EXECUTE FUNCTION public.boards_guard_seal();--> statement-breakpoint
-- the board column GRANT (0014) loses the seal columns too (belt and braces for UPDATE)
REVOKE UPDATE ON public.boards FROM anon, authenticated;--> statement-breakpoint
GRANT UPDATE (id, user_id, title, area, matrix_item_id, version, source_board_id, archived_at, created_at, updated_at) ON public.boards TO authenticated;--> statement-breakpoint
-- profiles.onboarding_answers: server-owned (profiles UPDATE is per column, 0001/0012; no GRANT added). cards.suspended_at: the
-- cards table has a table-level grant and owner-only RLS; suspending is the owner's own choice, nothing to guard.
-- P-192 (D-494): email_suppressions, server connection only (RLS on, no policy, no grant).
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.email_suppressions FROM anon, authenticated;
