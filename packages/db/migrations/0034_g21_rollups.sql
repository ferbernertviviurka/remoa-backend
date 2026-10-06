-- G21/F29 FR-23, CCR-055 (D-1029..D-1031): rollups map_stats + user_daily_stats, kept in the writers' transaction by triggers.
-- Tables only + functions + triggers: no backfill here (FR-29). Backfill = job stats.rebuild (POST /v1/cron/stats.rebuild), in batches.
CREATE TABLE "map_stats" (
	"user_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"cards" integer DEFAULT 0 NOT NULL,
	"notes" integer DEFAULT 0 NOT NULL,
	"edges" integer DEFAULT 0 NOT NULL,
	"review" integer DEFAULT 0 NOT NULL,
	"watch" integer DEFAULT 0 NOT NULL,
	"steady" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"due" integer DEFAULT 0 NOT NULL,
	"reviewed" integer DEFAULT 0 NOT NULL,
	"r_sum" double precision DEFAULT 0 NOT NULL,
	"day_end" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "map_stats_user_id_board_id_pk" PRIMARY KEY("user_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "user_daily_stats" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"reviews" integer DEFAULT 0 NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"time_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_daily_stats_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "map_stats" ADD CONSTRAINT "map_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_stats" ADD CONSTRAINT "map_stats_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_daily_stats" ADD CONSTRAINT "user_daily_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "map_stats_board_idx" ON "map_stats" USING btree ("board_id");--> statement-breakpoint

-- RLS: own rows only. map_stats is recomputed by the reader under withUser (stale rows), so authenticated may insert/update its own;
-- user_daily_stats is written only by the triggers (security definer) and the rebuild function.
ALTER TABLE public.map_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.user_daily_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY map_stats_select ON public.map_stats FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
CREATE POLICY map_stats_insert ON public.map_stats FOR INSERT TO authenticated WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
CREATE POLICY map_stats_update ON public.map_stats FOR UPDATE TO authenticated USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));--> statement-breakpoint
CREATE POLICY user_daily_stats_select ON public.user_daily_stats FOR SELECT TO authenticated USING (user_id = (select auth.uid()));--> statement-breakpoint
REVOKE ALL ON public.map_stats, public.user_daily_stats FROM anon;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON public.map_stats FROM authenticated;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_daily_stats FROM authenticated;--> statement-breakpoint

-- Profile timezone as the API reads it (review/queue.ts dayWindow): invalid or missing -> America/Sao_Paulo. Never throws, so a bad
-- timezone can not fail an attempt insert.
CREATE FUNCTION public.study_tz(tz text) RETURNS text LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF tz IS NULL THEN RETURN 'America/Sao_Paulo'; END IF;
  PERFORM now() AT TIME ZONE tz;
  RETURN tz;
EXCEPTION WHEN others THEN
  RETURN 'America/Sao_Paulo';
END $$;--> statement-breakpoint

-- Rebuild one user's daily stats from attempts (idempotent). Same bucketing as the old reads: ((created_at at tz) - 4 h)::date.
-- The advisory lock serialises it with the attempts trigger of the same user, so a concurrent answer is neither lost nor counted twice.
CREATE FUNCTION public.rebuild_user_daily_stats(uid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  z text;
  n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('user_daily_stats:' || uid::text, 0));
  SELECT public.study_tz(p.timezone) INTO z FROM public.profiles p WHERE p.user_id = uid;
  z := coalesce(z, 'America/Sao_Paulo');
  DELETE FROM public.user_daily_stats WHERE user_id = uid;
  INSERT INTO public.user_daily_stats (user_id, day, reviews, hits, time_ms)
  SELECT uid, ((a.created_at AT TIME ZONE z) - interval '4 hours')::date, count(*)::int, (count(*) FILTER (WHERE a.grade >= 3))::int,
         coalesce(sum(a.duration_ms), 0)::bigint
  FROM public.attempts a WHERE a.user_id = uid GROUP BY 2;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rebuild_user_daily_stats(uuid) FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- attempts -> user_daily_stats. Statement-level with transition tables: one upsert per statement, not per row. Covers every writer,
-- including the cascades (board deleted, card purged after 30 days, account deleted), which an app-side hook would miss.
CREATE FUNCTION public.user_daily_stats_on_attempts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    FOR u IN SELECT DISTINCT user_id FROM old_rows ORDER BY 1 LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('user_daily_stats:' || u::text, 0));
    END LOOP;
    WITH z AS (SELECT x.user_id, public.study_tz(p.timezone) AS tz FROM (SELECT DISTINCT user_id FROM old_rows) x LEFT JOIN public.profiles p ON p.user_id = x.user_id),
    d AS (
      SELECT o.user_id, ((o.created_at AT TIME ZONE coalesce(z.tz, 'America/Sao_Paulo')) - interval '4 hours')::date AS day, count(*)::int AS n,
             (count(*) FILTER (WHERE o.grade >= 3))::int AS hits, coalesce(sum(o.duration_ms), 0)::bigint AS ms
      FROM old_rows o JOIN z ON z.user_id = o.user_id GROUP BY 1, 2)
    UPDATE public.user_daily_stats s SET reviews = s.reviews - d.n, hits = s.hits - d.hits, time_ms = s.time_ms - d.ms, updated_at = now()
    FROM d WHERE s.user_id = d.user_id AND s.day = d.day;
    DELETE FROM public.user_daily_stats s WHERE s.user_id IN (SELECT DISTINCT user_id FROM old_rows) AND s.reviews <= 0;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    FOR u IN SELECT DISTINCT user_id FROM new_rows ORDER BY 1 LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('user_daily_stats:' || u::text, 0));
    END LOOP;
    INSERT INTO public.user_daily_stats AS s (user_id, day, reviews, hits, time_ms)
    SELECT n.user_id, ((n.created_at AT TIME ZONE coalesce(z.tz, 'America/Sao_Paulo')) - interval '4 hours')::date, count(*)::int,
           (count(*) FILTER (WHERE n.grade >= 3))::int, coalesce(sum(n.duration_ms), 0)::bigint
    FROM new_rows n
    JOIN (SELECT x.user_id, public.study_tz(p.timezone) AS tz FROM (SELECT DISTINCT user_id FROM new_rows) x LEFT JOIN public.profiles p ON p.user_id = x.user_id) z
      ON z.user_id = n.user_id
    GROUP BY 1, 2
    ON CONFLICT (user_id, day) DO UPDATE SET reviews = s.reviews + excluded.reviews, hits = s.hits + excluded.hits,
      time_ms = s.time_ms + excluded.time_ms, updated_at = now();
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER attempts_daily_stats_ins AFTER INSERT ON public.attempts REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.user_daily_stats_on_attempts();--> statement-breakpoint
CREATE TRIGGER attempts_daily_stats_upd AFTER UPDATE ON public.attempts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.user_daily_stats_on_attempts();--> statement-breakpoint
CREATE TRIGGER attempts_daily_stats_del AFTER DELETE ON public.attempts REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.user_daily_stats_on_attempts();--> statement-breakpoint

-- Timezone change re-buckets the user's days (the old reads bucketed with the current timezone). Rare: one rebuild of that user.
CREATE FUNCTION public.user_daily_stats_on_tz() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.rebuild_user_daily_stats(NEW.user_id);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER profiles_tz_daily_stats AFTER UPDATE OF timezone ON public.profiles FOR EACH ROW
  WHEN (OLD.timezone IS DISTINCT FROM NEW.timezone) EXECUTE FUNCTION public.user_daily_stats_on_tz();--> statement-breakpoint

-- map_stats invalidation. A recall state drifts with the clock, so the row cannot be kept by +1/-1: writers mark it stale
-- (stale_at null, version + 1) and the next reader recomputes that board. `version` lets the reader's upsert lose against a write
-- that committed after the reader looked (where map_stats.version = excluded.version).
CREATE FUNCTION public.map_stats_on_fsrs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- also creates the row of another user's board (seed/shared): the daily scope of the hub = own boards + boards in map_stats
    INSERT INTO public.map_stats AS m (user_id, board_id, version)
    SELECT DISTINCT n.user_id, c.board_id, 1 FROM new_rows n JOIN public.cards c ON c.id = n.card_id
    ON CONFLICT (user_id, board_id) DO UPDATE SET version = m.version + 1, stale_at = NULL, updated_at = now();
  ELSIF TG_OP = 'UPDATE' THEN
    -- the rate path's lock statement is a no-op update: only real schedule changes count
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now()
    FROM (SELECT DISTINCT n.user_id, c.board_id FROM new_rows n
          JOIN old_rows o ON o.user_id = n.user_id AND o.card_id = n.card_id AND o.sub_id = n.sub_id
          JOIN public.cards c ON c.id = n.card_id
          WHERE (n.due, n.stability, n.reps, n.lapses, n.last_review, n.state, n.created_at)
            IS DISTINCT FROM (o.due, o.stability, o.reps, o.lapses, o.last_review, o.state, o.created_at)) x
    WHERE m.user_id = x.user_id AND m.board_id = x.board_id;
  ELSE
    -- a cascade from a deleted card finds no card here; the cards trigger already marked the board
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now()
    FROM (SELECT DISTINCT o.user_id, c.board_id FROM old_rows o JOIN public.cards c ON c.id = o.card_id) x
    WHERE m.user_id = x.user_id AND m.board_id = x.board_id;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER fsrs_state_map_stats_ins AFTER INSERT ON public.fsrs_state REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_fsrs();--> statement-breakpoint
CREATE TRIGGER fsrs_state_map_stats_upd AFTER UPDATE ON public.fsrs_state REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_fsrs();--> statement-breakpoint
CREATE TRIGGER fsrs_state_map_stats_del AFTER DELETE ON public.fsrs_state REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_fsrs();--> statement-breakpoint

-- cards and edges: every reader of the board (owner, and students of a seed/shared board) gets the row marked stale.
-- Card updates count only when they change what the stats see (autosave of x/y/size or text does not).
CREATE FUNCTION public.map_stats_on_board_content() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now() WHERE m.board_id IN (SELECT board_id FROM new_rows);
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now() WHERE m.board_id IN (SELECT board_id FROM old_rows);
  ELSIF TG_TABLE_NAME = 'cards' THEN
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now() WHERE m.board_id IN (
      SELECT b FROM new_rows n JOIN old_rows o ON o.id = n.id, LATERAL (VALUES (n.board_id), (o.board_id)) v(b)
      WHERE (n.board_id, n.type, n.deleted_at, n.suspended_at, n.payload->'steps', n.payload->'masks')
        IS DISTINCT FROM (o.board_id, o.type, o.deleted_at, o.suspended_at, o.payload->'steps', o.payload->'masks'));
  ELSE
    UPDATE public.map_stats m SET version = m.version + 1, stale_at = NULL, updated_at = now() WHERE m.board_id IN (
      SELECT b FROM new_rows n JOIN old_rows o ON o.id = n.id, LATERAL (VALUES (n.board_id), (o.board_id)) v(b)
      WHERE (n.board_id, n.from_card_id, n.to_card_id) IS DISTINCT FROM (o.board_id, o.from_card_id, o.to_card_id));
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER cards_map_stats_ins AFTER INSERT ON public.cards REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();--> statement-breakpoint
CREATE TRIGGER cards_map_stats_upd AFTER UPDATE ON public.cards REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();--> statement-breakpoint
CREATE TRIGGER cards_map_stats_del AFTER DELETE ON public.cards REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();--> statement-breakpoint
CREATE TRIGGER edges_map_stats_ins AFTER INSERT ON public.edges REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();--> statement-breakpoint
CREATE TRIGGER edges_map_stats_upd AFTER UPDATE ON public.edges REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();--> statement-breakpoint
CREATE TRIGGER edges_map_stats_del AFTER DELETE ON public.edges REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.map_stats_on_board_content();
