-- F31 (G23, CCR-080, D-1456–D-1465) + CCR-083 (D-1470). ADD VALUE runs inside the migration transaction (PG >= 12); nothing here
-- uses 'OUTRO', so that is allowed. Down (manual, in this order; an enum value cannot be dropped, so 'OUTRO' stays unless the type is
-- rebuilt after `update boards set area = 'CM' where area = 'OUTRO'`):
--   DROP TABLE public.card_prereqs;
--   DROP INDEX public.boards_path_slug_idx; DROP INDEX public.cards_board_path_order_idx;
--   ALTER TABLE public.boards DROP CONSTRAINT boards_path_chk, DROP CONSTRAINT boards_badges_chk, DROP COLUMN path, DROP COLUMN badges;
--   ALTER TABLE public.cards DROP CONSTRAINT cards_didactics_chk, DROP CONSTRAINT cards_sources_chk,
--     DROP COLUMN didactics, DROP COLUMN sources, DROP COLUMN path_order;
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <journal `when` of 0040>;
ALTER TYPE "public"."area" ADD VALUE 'OUTRO';--> statement-breakpoint
CREATE TABLE "card_prereqs" (
	"card_id" uuid NOT NULL,
	"prereq_card_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_prereqs_card_id_prereq_card_id_pk" PRIMARY KEY("card_id","prereq_card_id"),
	CONSTRAINT "card_prereqs_self_chk" CHECK ("card_prereqs"."card_id" <> "card_prereqs"."prereq_card_id")
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "path" jsonb;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "badges" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "didactics" jsonb;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "path_order" integer;--> statement-breakpoint
ALTER TABLE "card_prereqs" ADD CONSTRAINT "card_prereqs_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_prereqs" ADD CONSTRAINT "card_prereqs_prereq_card_id_cards_id_fk" FOREIGN KEY ("prereq_card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_prereqs_prereq_idx" ON "card_prereqs" USING btree ("prereq_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boards_path_slug_idx" ON "boards" USING btree (("path"->>'slug')) WHERE "boards"."path" is not null and "boards"."status" <> 'private';--> statement-breakpoint
CREATE INDEX "cards_board_path_order_idx" ON "cards" USING btree ("board_id","path_order") WHERE "cards"."path_order" is not null and "cards"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_path_chk" CHECK ("boards"."path" is null or jsonb_typeof("boards"."path") = 'object');--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_badges_chk" CHECK (badges <@ array['top10_enamed']::text[] and (cardinality(badges) = 0 or status <> 'private'));--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_didactics_chk" CHECK ("cards"."didactics" is null or jsonb_typeof("cards"."didactics") = 'object');--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_sources_chk" CHECK (jsonb_typeof("cards"."sources") = 'array');;--> statement-breakpoint
-- card_prereqs RLS: read = the card is readable (cards RLS: own, seed_approved, seed_draft only for reviewers);
-- write = owner of the card's board, and the prerequisite lives in the same board.
ALTER TABLE public.card_prereqs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.card_prereqs FROM anon;--> statement-breakpoint
CREATE POLICY card_prereqs_select ON public.card_prereqs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_prereqs.card_id));--> statement-breakpoint
CREATE POLICY card_prereqs_write ON public.card_prereqs FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cards c JOIN public.boards b ON b.id = c.board_id WHERE c.id = card_prereqs.card_id AND b.user_id = (select auth.uid())))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.cards c JOIN public.cards p ON p.board_id = c.board_id JOIN public.boards b ON b.id = c.board_id
    WHERE c.id = card_prereqs.card_id AND p.id = card_prereqs.prereq_card_id AND b.user_id = (select auth.uid())));
