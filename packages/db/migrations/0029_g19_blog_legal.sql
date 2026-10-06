CREATE TABLE "blog_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_assets_key_unique" UNIQUE("key"),
	CONSTRAINT "blog_assets_mime" CHECK ("blog_assets"."mime" in ('image/webp', 'image/jpeg', 'image/png', 'image/avif')),
	CONSTRAINT "blog_assets_dims" CHECK ("blog_assets"."width" > 0 and "blog_assets"."height" > 0 and "blog_assets"."size" > 0)
);
--> statement-breakpoint
CREATE TABLE "blog_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"intro" text DEFAULT '' NOT NULL,
	"intro_draft" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "blog_categories_slug" CHECK ("blog_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("blog_categories"."slug") <= 70)
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"seo_title" text,
	"description" text DEFAULT '' NOT NULL,
	"excerpt" text,
	"content_json" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"toc_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template" text DEFAULT 'leitura' NOT NULL,
	"category_id" uuid,
	"author_id" uuid,
	"cover_asset_id" uuid,
	"cover_alt" text DEFAULT '' NOT NULL,
	"focus_keyword" text,
	"robots" text DEFAULT 'index' NOT NULL,
	"canonical_url" text,
	"faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"content_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reading_minutes" integer DEFAULT 1 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "blog_posts_slug" CHECK ("blog_posts"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("blog_posts"."slug") <= 70),
	CONSTRAINT "blog_posts_template" CHECK (template in ('leitura', 'guia', 'destaque')),
	CONSTRAINT "blog_posts_status" CHECK (status in ('draft', 'scheduled', 'published', 'archived')),
	CONSTRAINT "blog_posts_robots" CHECK (robots in ('index', 'noindex')),
	CONSTRAINT "blog_posts_scheduled" CHECK ("blog_posts"."status" <> 'scheduled' or "blog_posts"."publish_at" is not null),
	CONSTRAINT "blog_posts_published" CHECK ("blog_posts"."status" <> 'published' or "blog_posts"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "blog_redirects" (
	"from_path" text PRIMARY KEY NOT NULL,
	"to_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_redirects_paths" CHECK ("blog_redirects"."from_path" like '/blog/%' and "blog_redirects"."to_path" like '/blog/%' and "blog_redirects"."from_path" <> "blog_redirects"."to_path")
);
--> statement-breakpoint
CREATE TABLE "blog_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_acceptances_document" CHECK (document in ('terms', 'privacy')),
	CONSTRAINT "legal_acceptances_version" CHECK ("legal_acceptances"."version" ~ '^[A-Za-z0-9._-]{1,32}$')
);
--> statement-breakpoint
CREATE TABLE "sitemap_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url_count" integer NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "terms_accepted_version" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "privacy_accepted_version" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blog_assets" ADD CONSTRAINT "blog_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_blog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."blog_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_cover_asset_id_blog_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."blog_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_revisions" ADD CONSTRAINT "blog_revisions_post_id_blog_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."blog_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_revisions" ADD CONSTRAINT "blog_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blog_posts_slug_live_idx" ON "blog_posts" USING btree ("slug") WHERE "blog_posts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "blog_posts_status_published_idx" ON "blog_posts" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "blog_posts_category_idx" ON "blog_posts" USING btree ("category_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "blog_revisions_post_idx" ON "blog_revisions" USING btree ("post_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_unique_idx" ON "legal_acceptances" USING btree ("user_id","document","version");--> statement-breakpoint
CREATE INDEX "sitemap_snapshots_generated_idx" ON "sitemap_snapshots" USING btree ("generated_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written (G19 / F27, CCR-040, D-908–D-913). Blog and sitemap tables are server-only (as F19, D-387): Supabase gives new
-- tables GRANT ALL, so start from REVOKE ALL and add no policy. The public site reads published posts through /v1/public/blog/*.
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.blog_assets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.blog_revisions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.blog_redirects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sitemap_snapshots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON public.blog_categories, public.blog_assets, public.blog_posts, public.blog_revisions, public.blog_redirects,
  public.sitemap_snapshots, public.legal_acceptances FROM anon, authenticated;--> statement-breakpoint
-- legal_acceptances: the owner reads own history; only the trigger below and the API write.
CREATE POLICY legal_acceptances_select ON public.legal_acceptances FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));--> statement-breakpoint
GRANT SELECT ON public.legal_acceptances TO authenticated;--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.blog_categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.blog_posts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- D-913 (FR-45): the sign-up sends terms_version / privacy_version in Supabase options.data; the profile trigger copies them
-- (accepted_at = server clock, never the client's) and writes the two legal_acceptances rows. Malformed or missing versions
-- (OAuth, old clients) leave the columns null: the web then asks via POST /v1/account/legal/accept. profiles.*_accepted_* get
-- no column GRANT (profiles UPDATE is per column, 0001/0012), so only the server sets them.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tv text := NEW.raw_user_meta_data ->> 'terms_version';
  pv text := NEW.raw_user_meta_data ->> 'privacy_version';
  valid boolean := coalesce(tv ~ '^[A-Za-z0-9._-]{1,32}$' AND pv ~ '^[A-Za-z0-9._-]{1,32}$', false);
BEGIN
  INSERT INTO public.profiles (user_id, name, terms_accepted_version, privacy_accepted_version, accepted_at)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'name', CASE WHEN valid THEN tv END, CASE WHEN valid THEN pv END, CASE WHEN valid THEN now() END)
  ON CONFLICT DO NOTHING;
  IF valid THEN
    INSERT INTO public.legal_acceptances (user_id, document, version)
    VALUES (NEW.id, 'terms', tv), (NEW.id, 'privacy', pv) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- FR-14: the 4 initial categories (D-911). Intros are placeholders (intro_draft = true, hidden on the public page) until content (T10) writes them.
INSERT INTO public.blog_categories (slug, name, intro, intro_draft, position) VALUES
  ('estrategia-de-estudo', 'Estratégia de estudo', 'Rascunho: texto de apresentação da categoria (150 a 300 palavras) a escrever.', true, 0),
  ('tecnicas-de-memorizacao', 'Técnicas de memorização', 'Rascunho: texto de apresentação da categoria (150 a 300 palavras) a escrever.', true, 1),
  ('enamed-e-residencia', 'Enamed e residência', 'Rascunho: texto de apresentação da categoria (150 a 300 palavras) a escrever.', true, 2),
  ('produtividade', 'Produtividade', 'Rascunho: texto de apresentação da categoria (150 a 300 palavras) a escrever.', true, 3)
ON CONFLICT (slug) DO NOTHING;
