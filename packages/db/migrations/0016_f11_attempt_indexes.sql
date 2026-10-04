CREATE INDEX IF NOT EXISTS attempts_user_created_idx ON public.attempts (user_id, created_at);
CREATE INDEX IF NOT EXISTS attempts_user_card_created_idx ON public.attempts (user_id, card_id, created_at);
