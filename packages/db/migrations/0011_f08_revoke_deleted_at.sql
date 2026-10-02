-- F08 (qa T5): deleted_at is server-owned. A user writing it via PostgREST would skip the Stripe cancel, or schedule/undo their own purge.
REVOKE UPDATE (deleted_at) ON public.profiles FROM authenticated;
