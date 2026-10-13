CREATE TABLE "question_superseded" (
	"question_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_superseded" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_superseded" ADD CONSTRAINT "question_superseded_question_id_question_bank_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_bank"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- CCR-149 / D-1833: materialize the catalog `latest` rule. A row is listed here iff a newer version hides it from its own perspective:
-- private q: any row of the same group and owner; public q: a public row that is or was published. Rule identical to catalog/service.ts `latest`.
REVOKE ALL ON public.question_superseded FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE FUNCTION public.f34_question_superseded_sync(keys uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(cardinality(keys),0) = 0 THEN RETURN; END IF;
 -- Serialize writers of one version group (sorted: stable lock order). The statement below then takes a fresh READ COMMITTED snapshot,
 -- so it sees the rows of a concurrent writer that held the lock first. Writers must use READ COMMITTED (the default).
 PERFORM pg_advisory_xact_lock(hashtextextended('question_superseded:' || k::text, 0)) FROM (SELECT DISTINCT k FROM unnest(keys) k ORDER BY k) g;
 WITH want AS (
  SELECT q.id FROM public.question_bank q WHERE coalesce(q.canonical_id,q.id) = ANY(keys) AND EXISTS (SELECT 1 FROM public.question_bank newer
   WHERE coalesce(newer.canonical_id,newer.id) = coalesce(q.canonical_id,q.id) AND (newer.version,newer.created_at,newer.id) > (q.version,q.created_at,q.id)
   AND ((q.visibility='private' AND newer.user_id=q.user_id) OR (q.visibility='public' AND newer.visibility='public' AND (newer.published_at IS NOT NULL OR newer.catalog_status='published'))))
 ), gone AS (
  DELETE FROM public.question_superseded s USING public.question_bank q
  WHERE s.question_id = q.id AND coalesce(q.canonical_id,q.id) = ANY(keys) AND s.question_id NOT IN (SELECT id FROM want)
 )
 INSERT INTO public.question_superseded(question_id) SELECT id FROM want ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.f34_question_superseded_on_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  PERFORM public.f34_question_superseded_sync(ARRAY(SELECT coalesce(canonical_id,id) FROM new_rows));
 ELSIF TG_OP = 'DELETE' THEN
  PERFORM public.f34_question_superseded_sync(ARRAY(SELECT coalesce(canonical_id,id) FROM old_rows));
 ELSE
  -- Only the inputs of the rule; ids never change. Bulk withdrawals (published_at kept) and content/stat updates resolve to no group.
  PERFORM public.f34_question_superseded_sync(ARRAY(
   SELECT k FROM old_rows o JOIN new_rows n ON n.id = o.id, LATERAL (VALUES (coalesce(o.canonical_id,o.id)), (coalesce(n.canonical_id,n.id))) v(k)
   WHERE (o.canonical_id, o.version, o.created_at, o.visibility, o.user_id, o.published_at IS NOT NULL OR o.catalog_status = 'published')
    IS DISTINCT FROM (n.canonical_id, n.version, n.created_at, n.visibility, n.user_id, n.published_at IS NOT NULL OR n.catalog_status = 'published')));
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f34_question_superseded_sync(uuid[]) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f34_question_superseded_on_write() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER question_superseded_ins AFTER INSERT ON public.question_bank REFERENCING NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.f34_question_superseded_on_write();
--> statement-breakpoint
CREATE TRIGGER question_superseded_upd AFTER UPDATE ON public.question_bank REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.f34_question_superseded_on_write();
--> statement-breakpoint
CREATE TRIGGER question_superseded_del AFTER DELETE ON public.question_bank REFERENCING OLD TABLE AS old_rows
 FOR EACH STATEMENT EXECUTE FUNCTION public.f34_question_superseded_on_write();
--> statement-breakpoint
-- Backfill: CREATE TRIGGER above already holds SHARE ROW EXCLUSIVE on question_bank until commit, so no write slips in between.
INSERT INTO public.question_superseded(question_id)
SELECT q.id FROM public.question_bank q WHERE EXISTS (SELECT 1 FROM public.question_bank newer
 WHERE coalesce(newer.canonical_id,newer.id) = coalesce(q.canonical_id,q.id) AND (newer.version,newer.created_at,newer.id) > (q.version,q.created_at,q.id)
 AND ((q.visibility='private' AND newer.user_id=q.user_id) OR (q.visibility='public' AND newer.visibility='public' AND (newer.published_at IS NOT NULL OR newer.catalog_status='published'))));
--> statement-breakpoint
ANALYZE public.question_superseded;
