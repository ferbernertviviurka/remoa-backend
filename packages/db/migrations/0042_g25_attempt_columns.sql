-- D-1633: databases that already applied 0041 granted SELECT on every column of challenge_attempts.
-- missing, covered and hint are the points the student did not cover. Revoke the table grant and keep the public columns.
REVOKE SELECT ON public.challenge_attempts FROM authenticated;--> statement-breakpoint
GRANT SELECT (id, item_id, user_id, attempt_no, answer, answer_hash, verdict, critical_error, manipulation, feedback, used_hint, confidence,
  graded_by, model, prompt_version, latency_ms, rating, disputed, created_at) ON public.challenge_attempts TO authenticated;
