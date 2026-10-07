-- D-1567: time per answer and the study advice of a finished challenge. Written by the server connection only.
ALTER TABLE "challenge_attempts" ADD COLUMN "elapsed_ms" integer;--> statement-breakpoint
ALTER TABLE "challenge_sessions" ADD COLUMN "recommendations" jsonb;--> statement-breakpoint
GRANT SELECT (elapsed_ms) ON public.challenge_attempts TO authenticated;
