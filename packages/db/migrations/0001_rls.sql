-- Hand-written: RLS, profile trigger, updated_at trigger. See docs/ARCHITECTURE.md "Autenticação e papéis".

-- helpers ---------------------------------------------------------------
CREATE FUNCTION public.is_reviewer() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND role IN ('reviewer', 'admin')) $$;
--> statement-breakpoint
CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, name) VALUES (NEW.id, NEW.raw_user_meta_data ->> 'name') ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at' LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- enable RLS everywhere --------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_\_%' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- profiles: own row; role/deleted flags not self-editable ----------------
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
REVOKE UPDATE ON public.profiles FROM authenticated;
--> statement-breakpoint
GRANT UPDATE (name, school, year, goal, timezone, onboarding_done_at, deleted_at) ON public.profiles TO authenticated;
--> statement-breakpoint

-- plain user_id tables ---------------------------------------------------
CREATE POLICY assets_own ON public.assets FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY fsrs_state_own ON public.fsrs_state FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY attempts_own ON public.attempts FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY sessions_own ON public.sessions FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY imports_own ON public.imports FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
-- billing/usage/ai cost: read own; writes only by server (service role / direct connection)
CREATE POLICY subscriptions_select ON public.subscriptions FOR SELECT TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY usage_counters_select ON public.usage_counters FOR SELECT TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY ai_calls_select ON public.ai_calls FOR SELECT TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.subscriptions, public.usage_counters, public.ai_calls FROM authenticated, anon;
--> statement-breakpoint

-- boards -----------------------------------------------------------------
CREATE POLICY boards_select ON public.boards FOR SELECT TO authenticated USING (
  user_id = auth.uid() OR status = 'seed_approved' OR (status = 'seed_draft' AND public.is_reviewer())
);
--> statement-breakpoint
CREATE POLICY boards_insert ON public.boards FOR INSERT TO authenticated WITH CHECK (
  user_id = auth.uid() AND (status = 'private' OR public.is_reviewer())
);
--> statement-breakpoint
CREATE POLICY boards_update ON public.boards FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND (status = 'private' OR public.is_reviewer()));
--> statement-breakpoint
CREATE POLICY boards_delete ON public.boards FOR DELETE TO authenticated USING (user_id = auth.uid());
--> statement-breakpoint

-- board children: read = can see the board (boards policy applies in the subquery); write = owns the board
CREATE POLICY cards_select ON public.cards FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id));
--> statement-breakpoint
CREATE POLICY cards_write ON public.cards FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()));
--> statement-breakpoint
CREATE POLICY edges_select ON public.edges FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id));
--> statement-breakpoint
CREATE POLICY edges_write ON public.edges FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()));
--> statement-breakpoint
CREATE POLICY masks_select ON public.masks FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_id));
--> statement-breakpoint
CREATE POLICY masks_write ON public.masks FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cards c JOIN public.boards b ON b.id = c.board_id WHERE c.id = card_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cards c JOIN public.boards b ON b.id = c.board_id WHERE c.id = card_id AND b.user_id = auth.uid()));
--> statement-breakpoint
CREATE POLICY board_matrix_items_select ON public.board_matrix_items FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id));
--> statement-breakpoint
CREATE POLICY board_matrix_items_write ON public.board_matrix_items FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()));
--> statement-breakpoint
CREATE POLICY board_versions_select ON public.board_versions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id));
--> statement-breakpoint
CREATE POLICY board_versions_write ON public.board_versions FOR ALL TO authenticated
  USING (public.is_reviewer() AND EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()))
  WITH CHECK (public.is_reviewer() AND EXISTS (SELECT 1 FROM public.boards b WHERE b.id = board_id AND b.user_id = auth.uid()));
--> statement-breakpoint

-- matrix: read-only for everyone signed in (writes via seed / service connection)
CREATE POLICY matrix_items_select ON public.matrix_items FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.matrix_items FROM authenticated, anon;
--> statement-breakpoint

-- editorial queue: reviewers manage; any user can flag a card they can see
CREATE POLICY review_queue_reviewer ON public.review_queue FOR ALL TO authenticated USING (public.is_reviewer()) WITH CHECK (public.is_reviewer());
--> statement-breakpoint
CREATE POLICY review_queue_flag ON public.review_queue FOR INSERT TO authenticated WITH CHECK (
  flag_source = 'user_disagree' AND status = 'pending' AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_id)
);
--> statement-breakpoint

-- waitlist: insert-only, no read
CREATE POLICY waitlist_insert ON public.waitlist FOR INSERT TO anon, authenticated WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON public.waitlist FROM anon, authenticated;
--> statement-breakpoint
GRANT INSERT ON public.waitlist TO anon, authenticated;
