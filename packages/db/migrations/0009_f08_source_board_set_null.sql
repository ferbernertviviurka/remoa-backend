ALTER TABLE "boards" DROP CONSTRAINT "boards_source_board_id_boards_id_fk";
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_source_board_id_boards_id_fk" FOREIGN KEY ("source_board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;