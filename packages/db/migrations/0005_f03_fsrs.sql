ALTER TABLE "fsrs_state" ADD COLUMN "learning_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fsrs_state" ADD COLUMN "scheduled_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- P-004 (rest): study rows only for cards the user can read (cards RLS applies inside the subquery).
DROP POLICY fsrs_state_own ON public.fsrs_state;
--> statement-breakpoint
CREATE POLICY fsrs_state_own ON public.fsrs_state FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_id));
--> statement-breakpoint
DROP POLICY attempts_own ON public.attempts;
--> statement-breakpoint
CREATE POLICY attempts_own ON public.attempts FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_id));
