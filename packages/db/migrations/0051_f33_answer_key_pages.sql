-- CCR133 source only. Generated column/check plus reviewed custom guards; NOT applied by this task.
-- Null means the complete original answer-key document for legacy imports. Never crop or renumber pages.
CREATE FUNCTION public.f33_valid_answer_key_pages(pages integer[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
DECLARE page_number integer; previous_page integer := 0;
BEGIN
 IF pg_catalog.array_ndims(pages) IS DISTINCT FROM 1
    OR pg_catalog.array_lower(pages, 1) IS DISTINCT FROM 1
    OR pg_catalog.cardinality(pages) NOT BETWEEN 1 AND 500 THEN
   RETURN false;
 END IF;
 FOREACH page_number IN ARRAY pages LOOP
   IF page_number IS NULL OR page_number NOT BETWEEN 1 AND 500 OR page_number <= previous_page THEN
     RETURN false;
   END IF;
   previous_page := page_number;
 END LOOP;
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_valid_answer_key_pages(integer[]) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER TABLE "question_imports" ADD COLUMN "answer_key_pages" integer[];--> statement-breakpoint
ALTER TABLE "question_imports" ADD CONSTRAINT "question_imports_answer_key_pages_chk" CHECK ("question_imports"."answer_key_pages" is null or ("question_imports"."answer_key_document_id" is not null and public.f33_valid_answer_key_pages("question_imports"."answer_key_pages")));
--> statement-breakpoint
-- Selection and its original document binding are immutable, including null -> selected transitions.
-- Document metadata is read without acquiring a late source/graph lock. The API validates it before job creation.
CREATE FUNCTION public.f33_answer_key_pages_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE document_pages integer;
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF NEW.answer_key_pages IS DISTINCT FROM OLD.answer_key_pages
      OR NEW.answer_key_document_id IS DISTINCT FROM OLD.answer_key_document_id THEN
     RAISE EXCEPTION 'answer_key_selection_immutable_create_new_import' USING ERRCODE = '23514';
   END IF;
 END IF;
 IF NEW.answer_key_pages IS NOT NULL THEN
   IF NOT public.f33_valid_answer_key_pages(NEW.answer_key_pages) OR NEW.answer_key_document_id IS NULL THEN
     RAISE EXCEPTION 'answer_key_pages_invalid' USING ERRCODE = '23514';
   END IF;
   SELECT d.pages INTO document_pages FROM public.question_documents d
   WHERE d.id = NEW.answer_key_document_id AND d.source_id = NEW.source_id AND d.kind = 'answer_key';
   IF document_pages IS NULL OR NEW.answer_key_pages[pg_catalog.cardinality(NEW.answer_key_pages)] > document_pages THEN
     RAISE EXCEPTION 'answer_key_pages_out_of_document' USING ERRCODE = '23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_answer_key_pages_guard() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TRIGGER question_imports_answer_key_pages_guard BEFORE INSERT OR UPDATE ON public.question_imports
FOR EACH ROW EXECUTE FUNCTION public.f33_answer_key_pages_guard();
--> statement-breakpoint
-- Existing table RLS/revokes remain in0044. Do not expose private selection metadata through direct SQL.
REVOKE SELECT(answer_key_pages), INSERT(answer_key_pages), UPDATE(answer_key_pages)
ON public.question_imports FROM PUBLIC, anon, authenticated;
