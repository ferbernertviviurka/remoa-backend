-- CCR124: frozen text/assets must obey current API rights gates, never an owner-only direct snapshot read.
-- Remove both table-wide and column grants so inherited table access cannot override the protected column.
REVOKE SELECT ON public.question_session_items FROM authenticated, anon, PUBLIC;
--> statement-breakpoint
REVOKE SELECT (payload_public) ON public.question_session_items FROM authenticated, anon, PUBLIC;
--> statement-breakpoint
GRANT SELECT (id,user_id,session_id,question_id,position,original_number,selected_key,doubtful,answered,revision,created_at,updated_at) ON public.question_session_items TO authenticated;
