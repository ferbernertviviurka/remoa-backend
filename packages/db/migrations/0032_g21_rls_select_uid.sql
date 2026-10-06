-- G21/F29 FR-27 (D-1022): RLS evaluated once per statement, not once per row.
-- 1) Every `auth.uid()` becomes `(select auth.uid())` and every `is_reviewer()` becomes `(select public.is_reviewer())`: the planner
--    turns them into InitPlans (one call per statement). is_reviewer() is already `security definer stable` (0001), so the role check
--    lives in a function wrapped in select, as FR-27 asks; no new function needed.
-- 2) cards_select / edges_select / cards_write / edges_write (USING) / board_matrix_items_write / board_versions_write:
--    correlated `exists (select 1 from boards b where b.id = X.board_id ...)` -> `board_id in (select b.id from boards b ...)`, which plans
--    as a hashed SubPlan over the caller's visible boards (tens of rows) instead of one boards probe + boards_select per card/edge row.
--    Equivalent: board_id is NOT NULL on all of them, and boards' own RLS still applies inside the subquery (same as before).
-- Kept as correlated exists on purpose (PK lookups on single-row writes; an IN would hash every visible card): masks_*, the
-- exists(cards) in fsrs_state/attempts/edges WITH CHECK, calendar_events label/asset checks, support_* .
-- ALTER POLICY keeps name, command, roles and permissiveness; only the expressions change. Semantics unchanged (rls*.test.ts).
-- Tables untouched by this file: masks_select, board_matrix_items_select, board_versions_select (exists over boards/cards, no uid),
-- matrix_items_select, review_queue_flag, waitlist_insert, assets_select_via_card, legal_acceptances_select (already wrapped).

-- profiles
ALTER POLICY profiles_select ON public.profiles USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY profiles_update ON public.profiles USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint

-- owner-only tables
ALTER POLICY assets_own ON public.assets USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY sessions_own ON public.sessions USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY imports_own ON public.imports USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY fsrs_state_own ON public.fsrs_state USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = fsrs_state.card_id));--> statement-breakpoint
ALTER POLICY attempts_own ON public.attempts USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = attempts.card_id));--> statement-breakpoint

-- read-only per user
ALTER POLICY subscriptions_select ON public.subscriptions USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY usage_counters_select ON public.usage_counters USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY ai_calls_select ON public.ai_calls USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY account_events_select ON public.account_events USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY referral_codes_select ON public.referral_codes USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY entitlement_grants_select ON public.entitlement_grants USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY billing_credits_select ON public.billing_credits USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY store_waitlist_select ON public.store_waitlist USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_reminders_select ON public.calendar_reminders USING (user_id = (select auth.uid()));--> statement-breakpoint

-- boards
ALTER POLICY boards_select ON public.boards USING (
  user_id = (select auth.uid()) OR status = 'seed_approved' OR (status = 'seed_draft' AND (select public.is_reviewer())));--> statement-breakpoint
ALTER POLICY boards_insert ON public.boards WITH CHECK (user_id = (select auth.uid()) AND (status = 'private' OR (select public.is_reviewer())));--> statement-breakpoint
ALTER POLICY boards_update ON public.boards USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND (status = 'private' OR (select public.is_reviewer())));--> statement-breakpoint
ALTER POLICY boards_delete ON public.boards USING (user_id = (select auth.uid()));--> statement-breakpoint

-- cards / edges: semi-join over visible (select) or owned (write) boards
ALTER POLICY cards_select ON public.cards USING (board_id IN (SELECT b.id FROM public.boards b));--> statement-breakpoint
ALTER POLICY cards_write ON public.cards
  USING (board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())))
  WITH CHECK (board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())));--> statement-breakpoint
ALTER POLICY edges_select ON public.edges USING (board_id IN (SELECT b.id FROM public.boards b));--> statement-breakpoint
ALTER POLICY edges_write ON public.edges
  USING (board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())))
  WITH CHECK (
    board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid()))
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = edges.from_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = edges.to_card_id AND c.board_id = edges.board_id AND c.deleted_at IS NULL));--> statement-breakpoint
ALTER POLICY masks_write ON public.masks
  USING (EXISTS (SELECT 1 FROM public.cards c JOIN public.boards b ON b.id = c.board_id WHERE c.id = masks.card_id AND b.user_id = (select auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.cards c JOIN public.boards b ON b.id = c.board_id WHERE c.id = masks.card_id AND b.user_id = (select auth.uid())));--> statement-breakpoint
ALTER POLICY board_matrix_items_write ON public.board_matrix_items
  USING (board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())))
  WITH CHECK (board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())));--> statement-breakpoint
ALTER POLICY board_versions_write ON public.board_versions
  USING ((select public.is_reviewer()) AND board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())))
  WITH CHECK ((select public.is_reviewer()) AND board_id IN (SELECT b.id FROM public.boards b WHERE b.user_id = (select auth.uid())));--> statement-breakpoint
ALTER POLICY review_queue_reviewer ON public.review_queue USING ((select public.is_reviewer())) WITH CHECK ((select public.is_reviewer()));--> statement-breakpoint

-- account (0012)
ALTER POLICY user_preferences_select ON public.user_preferences USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY user_preferences_insert ON public.user_preferences WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY user_preferences_update ON public.user_preferences USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint

-- support (0021)
ALTER POLICY support_tickets_select ON public.support_tickets USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY support_messages_select ON public.support_messages USING (
  NOT internal AND EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = support_messages.ticket_id AND t.user_id = (select auth.uid())));--> statement-breakpoint
ALTER POLICY support_attachments_select ON public.support_attachments USING (EXISTS (
  SELECT 1 FROM public.support_messages m JOIN public.support_tickets t ON t.id = m.ticket_id
  WHERE m.id = support_attachments.message_id AND NOT m.internal AND t.user_id = (select auth.uid())));--> statement-breakpoint

-- notifications + calendar (0026)
ALTER POLICY notifications_select ON public.notifications USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY notifications_update ON public.notifications USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY notification_preferences_select ON public.notification_preferences USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY notification_preferences_insert ON public.notification_preferences WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY notification_preferences_update ON public.notification_preferences USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_labels_select ON public.calendar_labels USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_labels_insert ON public.calendar_labels WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_labels_update ON public.calendar_labels USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_labels_delete ON public.calendar_labels USING (user_id = (select auth.uid()) AND system_key IS DISTINCT FROM 'personal');--> statement-breakpoint
ALTER POLICY calendar_events_select ON public.calendar_events USING (user_id = (select auth.uid()));--> statement-breakpoint
ALTER POLICY calendar_events_insert ON public.calendar_events WITH CHECK (
  user_id = (select auth.uid())
  AND EXISTS (SELECT 1 FROM public.calendar_labels l WHERE l.id = calendar_events.label_id AND l.user_id = (select auth.uid()))
  AND (cover_asset_id IS NULL OR EXISTS (SELECT 1 FROM public.assets a WHERE a.id = calendar_events.cover_asset_id AND a.user_id = (select auth.uid()))));--> statement-breakpoint
ALTER POLICY calendar_events_update ON public.calendar_events USING (user_id = (select auth.uid())) WITH CHECK (
  user_id = (select auth.uid())
  AND EXISTS (SELECT 1 FROM public.calendar_labels l WHERE l.id = calendar_events.label_id AND l.user_id = (select auth.uid()))
  AND (cover_asset_id IS NULL OR EXISTS (SELECT 1 FROM public.assets a WHERE a.id = calendar_events.cover_asset_id AND a.user_id = (select auth.uid()))));
