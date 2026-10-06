// G19 / F27 Blog + legal acceptance (CCR-040, D-908–D-915). RLS, grants, triggers and the category seed are hand-written
// at the end of migrations/0029_g19_blog_legal.sql. Every blog_* / sitemap_* table is server-only (no policy, no grant):
// the API reads and writes them with its own connection; the public site reads published posts through /v1/public/blog/*.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { blogRobots, blogStatuses, blogTemplates, legalDocuments } from '@remoa/contracts';
import { authUsers, timestamps, userId } from './common';

const inList = (col: string, values: readonly string[]) => sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(', ')})`);
const slugRe = `'^[a-z0-9]+(-[a-z0-9]+)*$'`;

export const blogCategories = pgTable('blog_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** FR-14: 150–300 words for the category page. */
  intro: text('intro').notNull().default(''),
  /** D-911: seeded intros are placeholders; the public page shows the intro only when false. */
  introDraft: boolean('intro_draft').notNull().default(true),
  position: integer('position').notNull().default(0),
  ...timestamps,
}, (t) => [
  check('blog_categories_slug', sql`${t.slug} ~ ${sql.raw(slugRe)} and char_length(${t.slug}) <= 70`),
]);

export const blogAssets = pgTable('blog_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Object key in the public bucket (S3_PUBLIC_BUCKET), main WebP; URL = R2_PUBLIC_BASE_URL + '/' + key. */
  key: text('key').notNull().unique(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  /** BlogAssetVariant[] ({ key, width, height, format }) written by the upload (FR-26). */
  variants: jsonb('variants').notNull().default([]),
  createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
  createdAt: timestamps.createdAt,
}, (t) => [
  check('blog_assets_mime', sql`${t.mime} in ('image/webp', 'image/jpeg', 'image/png', 'image/avif')`),
  check('blog_assets_dims', sql`${t.width} > 0 and ${t.height} > 0 and ${t.size} > 0`),
]);

export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  seoTitle: text('seo_title'),
  description: text('description').notNull().default(''),
  excerpt: text('excerpt'),
  /** BlogDoc (contracts/blog), stored as the zod parse output (unknown keys stripped). */
  contentJson: jsonb('content_json').notNull().default({ type: 'doc', content: [] }),
  /** Sanitized HTML cache, rebuilt on every content save (packages/blog renderer, T1). */
  contentHtml: text('content_html').notNull().default(''),
  tocJson: jsonb('toc_json').notNull().default([]),
  template: text('template').notNull().default('leitura'),
  categoryId: uuid('category_id').references(() => blogCategories.id, { onDelete: 'set null' }),
  /** null = "Equipe Remoa" (Q-065). */
  authorId: uuid('author_id').references(() => authUsers.id, { onDelete: 'set null' }),
  coverAssetId: uuid('cover_asset_id').references(() => blogAssets.id, { onDelete: 'set null' }),
  coverAlt: text('cover_alt').notNull().default(''),
  focusKeyword: text('focus_keyword'),
  robots: text('robots').notNull().default('index'),
  canonicalUrl: text('canonical_url'),
  /** FAQ items of the content (cache for the FAQPage JSON-LD). */
  faq: jsonb('faq').notNull().default([]),
  status: text('status').notNull().default('draft'),
  /** When a scheduled post goes out (blog.publish-scheduled). */
  publishAt: timestamp('publish_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** Last change of title/description/content/cover: sitemap lastmod and dateModified. */
  contentUpdatedAt: timestamp('content_updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  readingMinutes: integer('reading_minutes').notNull().default(1),
  wordCount: integer('word_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
  ...timestamps,
  /** Logical delete (FR-13); blog.cleanup purges after 30 days. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('blog_posts_slug_live_idx').on(t.slug).where(sql`${t.deletedAt} is null`),
  index('blog_posts_status_published_idx').on(t.status, t.publishedAt.desc()),
  index('blog_posts_category_idx').on(t.categoryId, t.publishedAt.desc()),
  check('blog_posts_slug', sql`${t.slug} ~ ${sql.raw(slugRe)} and char_length(${t.slug}) <= 70`),
  check('blog_posts_template', inList('template', blogTemplates)),
  check('blog_posts_status', inList('status', blogStatuses)),
  check('blog_posts_robots', inList('robots', blogRobots)),
  check('blog_posts_scheduled', sql`${t.status} <> 'scheduled' or ${t.publishAt} is not null`),
  check('blog_posts_published', sql`${t.status} <> 'published' or ${t.publishedAt} is not null`),
]);

/** FR-11: last 20 content versions per post (the API trims older ones on insert). */
export const blogRevisions = pgTable('blog_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  contentJson: jsonb('content_json').notNull(),
  createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
  createdAt: timestamps.createdAt,
}, (t) => [index('blog_revisions_post_idx').on(t.postId, t.createdAt.desc())]);

/** FR-12: 301 from an old /blog/<slug> to the new one. */
export const blogRedirects = pgTable('blog_redirects', {
  fromPath: text('from_path').primaryKey(),
  toPath: text('to_path').notNull(),
  createdAt: timestamps.createdAt,
}, (t) => [
  check('blog_redirects_paths', sql`${t.fromPath} like '/blog/%' and ${t.toPath} like '/blog/%' and ${t.fromPath} <> ${t.toPath}`),
]);

/** FR-33: one row per sitemap change (daily job or publish). */
export const sitemapSnapshots = pgTable('sitemap_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().default(sql`now()`),
  urlCount: integer('url_count').notNull(),
  /** sha256 hex of the sorted "url lastmod" lines. */
  hash: text('hash').notNull(),
}, (t) => [index('sitemap_snapshots_generated_idx').on(t.generatedAt.desc())]);

/** FR-45/46: every acceptance of a legal document version (D-913). Owner reads own rows; written by the signup trigger and the API. */
export const legalAcceptances = pgTable('legal_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  document: text('document').notNull(),
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('legal_acceptances_unique_idx').on(t.userId, t.document, t.version),
  check('legal_acceptances_document', inList('document', legalDocuments)),
  check('legal_acceptances_version', sql`${t.version} ~ '^[A-Za-z0-9._-]{1,32}$'`),
]);
