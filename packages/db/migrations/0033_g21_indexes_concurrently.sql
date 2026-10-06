-- no-transaction
-- G21/F29 FR-26/FR-29 (D-1023, D-1024): missing FK / policy / ORDER BY indexes, built CONCURRENTLY so no table is write-locked.
-- The first line marks this file for src/migrate.ts: each statement runs on its own, outside a transaction (Postgres refuses
-- CREATE INDEX CONCURRENTLY inside one, and drizzle's migrator wraps all pending files in a single transaction).
-- If a build fails midway it leaves an INVALID index that IF NOT EXISTS would skip: `drop index concurrently <name>` and rerun.
-- Mirrored in src/schema (content.ts, study.ts) so drizzle-kit does not re-emit them. No index is dropped here (needs idx_scan, P-471).

-- assets_own policy (0001:52) and assets cleanup by owner; was PK only
CREATE INDEX CONCURRENTLY IF NOT EXISTS "assets_user_idx" ON "public"."assets" USING btree ("user_id");--> statement-breakpoint
-- getBoard: latest published changelog, apps/api/src/boards/boards.ts:90-95 (where board_id order by version desc limit 1); FK cascade
CREATE INDEX CONCURRENTLY IF NOT EXISTS "board_versions_board_version_idx" ON "public"."board_versions" USING btree ("board_id","version" DESC NULLS LAST);--> statement-breakpoint
-- listBoards: boards.ts:61-62 (user_id = $1 and archived_at is null order by updated_at desc)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "boards_user_updated_idx" ON "public"."boards" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE "archived_at" is null;--> statement-breakpoint
-- boards_select seed legs (status = 'seed_approved' / 'seed_draft', 0032) and listSeeds apps/api/src/editorial/editorial.ts:295
CREATE INDEX CONCURRENTLY IF NOT EXISTS "boards_status_idx" ON "public"."boards" USING btree ("status") WHERE "status" <> 'private';--> statement-breakpoint
-- getBoard cards: boards.ts:82-83 (board_id = $1 and deleted_at is null order by "order", created_at)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cards_board_order_idx" ON "public"."cards" USING btree ("board_id","order","created_at") WHERE "deleted_at" is null;--> statement-breakpoint
-- edges.from_card_id / to_card_id: ON DELETE CASCADE from cards (deleteBoard boards.ts:35-41, card purge), else a seq scan per deleted card
CREATE INDEX CONCURRENTLY IF NOT EXISTS "edges_from_card_idx" ON "public"."edges" USING btree ("from_card_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "edges_to_card_idx" ON "public"."edges" USING btree ("to_card_id");--> statement-breakpoint
-- saveMasks: apps/api/src/cards/cards.ts:90 (delete from masks where card_id = $1), masks_* policies, FK cascade
CREATE INDEX CONCURRENTLY IF NOT EXISTS "masks_card_idx" ON "public"."masks" USING btree ("card_id");--> statement-breakpoint
-- attempts.card_id: FK cascade from cards (existing attempts_* indexes start with user_id)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attempts_card_idx" ON "public"."attempts" USING btree ("card_id");--> statement-breakpoint
-- attempts.session_id: FK ON DELETE SET NULL from sessions (account purge)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attempts_session_idx" ON "public"."attempts" USING btree ("session_id") WHERE "session_id" is not null;--> statement-breakpoint
-- fsrs_state.card_id: FK cascade from cards (PK is (user_id, card_id, sub_id))
CREATE INDEX CONCURRENTLY IF NOT EXISTS "fsrs_state_card_idx" ON "public"."fsrs_state" USING btree ("card_id");--> statement-breakpoint
-- import busy check apps/api/src/imports/imports.ts:147 and overAnkiImports apps/api/src/billing/quota.ts:61; imports_own policy
CREATE INDEX CONCURRENTLY IF NOT EXISTS "imports_user_status_idx" ON "public"."imports" USING btree ("user_id","status");--> statement-breakpoint
-- editorial queue join on card (apps/api/src/editorial/editorial.ts:95-110), FK cascade from cards
CREATE INDEX CONCURRENTLY IF NOT EXISTS "review_queue_card_idx" ON "public"."review_queue" USING btree ("card_id");--> statement-breakpoint
-- onboarding sessions count apps/api/src/onboarding/onboarding.ts:20, inactivity max(started_at) apps/api/src/account/inactivity.ts:23; sessions_own
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_user_started_idx" ON "public"."sessions" USING btree ("user_id","started_at" DESC NULLS LAST);
