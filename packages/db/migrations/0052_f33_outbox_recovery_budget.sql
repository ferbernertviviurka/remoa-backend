-- CCR144/D-1805 source only; NOT applied by this task. Recovery budget for question-receipt/question-promotion outbox rows:
-- workers claim while attempts < attempt_limit; an audited admin recovery may raise attempt_limit by at most 5 over the row's lifetime.
ALTER TABLE "question_outbox" ADD COLUMN "attempt_limit" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_outbox" ADD CONSTRAINT "question_outbox_attempt_limit_chk" CHECK ("question_outbox"."attempt_limit" between 20 and 25);--> statement-breakpoint
-- History is never reset: neither the attempt counter nor the granted budget may go down.
CREATE FUNCTION public.f33_outbox_monotonic() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.attempts < OLD.attempts OR NEW.attempt_limit < OLD.attempt_limit THEN
    RAISE EXCEPTION 'question_outbox_history_monotonic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.f33_outbox_monotonic() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE TRIGGER question_outbox_monotonic BEFORE UPDATE OF attempts, attempt_limit ON public.question_outbox FOR EACH ROW EXECUTE FUNCTION public.f33_outbox_monotonic();
