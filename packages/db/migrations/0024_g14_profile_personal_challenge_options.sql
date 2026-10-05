ALTER TABLE "profiles" ADD COLUMN "goals" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "user_type" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "sex" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "address" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_type" CHECK (user_type in ('aluno', 'professor', 'medico_formado'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_sex" CHECK (sex in ('feminino', 'masculino', 'nao_binario', 'outro', 'prefiro_nao_dizer'));--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_phone" CHECK ("profiles"."phone" ~ '^[+]55[1-9]{2}(9[0-9]{8}|[2-5][0-9]{7})$');--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_address" CHECK (jsonb_typeof("profiles"."address") = 'object');--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_goals" CHECK (cardinality("profiles"."goals") <= 5);--> statement-breakpoint
-- Hand-written (CCR-017, D-570): objectives become multi-select; existing single goals seed the array.
UPDATE "profiles" SET "goals" = ARRAY["goal"] WHERE "goal" IS NOT NULL AND cardinality("goals") = 0;--> statement-breakpoint
-- CCR-017 (D-571): user_type, sex, phone, address and goals are PII/server-owned. profiles UPDATE is per column (0001/0012):
-- no GRANT here, so only the API connection writes them; reads stay owner-only (profiles_select, 0001).
-- CCR-019 (D-575): sessions.options follows the sessions policies (owner-only).
SELECT 1;
