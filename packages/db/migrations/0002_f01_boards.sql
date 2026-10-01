ALTER TABLE "boards" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- P-004 (edges part): both ends must be live cards of the edge's own board.
DROP POLICY edges_write ON public.edges;
--> statement-breakpoint
CREATE POLICY edges_write ON public.edges FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = from_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = to_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL)
  );
