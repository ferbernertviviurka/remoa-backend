-- G21 (D-1056, P-495, CCR-057): cards/edges RLS as `board_id = any(array(select ...))` instead of 0032's `board_id in (select ...)`.
-- Why: the IN form plans as a `hashed SubPlan` filter, and every `join cards x on x.id = ...` under RLS then chose `Seq Scan on cards`
-- (~156k pages; getBoard-edges 16 -> 400 ms, progress-weak 9 -> 167 ms in remoa_perf). `array(select ...)` is an InitPlan run once per
-- statement; the qual becomes `board_id = ANY($n)`, cheap per row after a PK probe and usable as an index condition on board_id
-- (loadCards-daily 214 -> 10 ms). Correlated exists (the 0001 form) was measured too and lost on the board-scan queries (1,4 s).
-- Same semantics as 0032: board_id is NOT NULL, and boards' own RLS still applies inside the subquery.
-- ponytail: `= ANY` is linear in the visible-board array (own + seed_approved [+ seed_draft for reviewers]); fine for tens to a few
-- hundred boards, re-measure if seed boards reach the thousands (security definer stable function returning a set is the next step).
ALTER POLICY cards_select ON public.cards USING (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b)));--> statement-breakpoint
ALTER POLICY cards_write ON public.cards
  USING (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid()))))
  WITH CHECK (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid()))));--> statement-breakpoint
ALTER POLICY edges_select ON public.edges USING (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b)));--> statement-breakpoint
ALTER POLICY edges_write ON public.edges
  USING (board_id = ANY (ARRAY(SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid()))))
  WITH CHECK (
    board_id = ANY (ARRAY(SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())))
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = edges.from_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = edges.to_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL));
