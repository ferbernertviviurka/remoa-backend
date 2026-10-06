// G19 F27 T2: blog post service (admin side). Every function takes the withAdmin transaction and returns a Result; the route
// runs the side effects (revalidation, sitemap) from the returned `fx` AFTER the commit.
import { and, asc, count, desc, eq, inArray, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  BLOG_LIMITS, blogErrors, err, ok, publishBlockers, slugify,
  type BlogAdminList, type BlogAdminListQuery, type BlogBlock, type BlogCategory, type BlogCategoryInput, type BlogDoc, type BlogListItem, type BlogPost, type BlogPostCreateInput,
  type BlogPostInput, type PublishBlocker, type Result, type SeoSubject,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm } from '../db';
import { likeOf } from '../admin/users/util';
import { assetDto, blogImageResolver, loadAssets } from './images';
import { renderPostSummary } from '@remoa/blog';

type Dbm = Awaited<ReturnType<typeof dbm>>;
/** A transaction or the plain connection (both expose the query builder). */
export type Q = Tx | Dbm['db'];
export type PostRow = Dbm['blogPosts']['$inferSelect'];
/** Effects to run after the commit (D-908 tags; sitemap only when the set of URLs changes). */
export type Fx = { tags: string[]; sitemap: boolean };
export const noFx: Fx = { tags: [], sitemap: false };

const docOf = (r: PostRow) => r.contentJson as unknown as BlogDoc;
export const seoSubject = (r: PostRow): SeoSubject => ({
  title: r.title, seoTitle: r.seoTitle, description: r.description, slug: r.slug, coverAssetId: r.coverAssetId, coverAlt: r.coverAlt, focusKeyword: r.focusKeyword, content: docOf(r),
});
export const blockersOf = (r: PostRow): PublishBlocker[] => publishBlockers(seoSubject(r));

/** Tags of D-908 for the given post (and its old slug / categories). */
export function tagsFor(slugs: string[], categorySlugs: (string | null | undefined)[]): string[] {
  return [...new Set(['blog', 'landing', 'sitemap', 'feed', ...slugs.map((s) => `blog:post:${s}`), ...categorySlugs.filter((s): s is string => !!s).map((s) => `blog:category:${s}`)])];
}
async function fxFor(q: Q, rows: { slug: string; categoryId: string | null }[], sitemap: boolean): Promise<Fx> {
  const { blogCategories } = await dbm();
  const ids = rows.map((r) => r.categoryId).filter((x): x is string => !!x);
  const cats = ids.length ? await q.select({ slug: blogCategories.slug }).from(blogCategories).where(inArray(blogCategories.id, ids)) : [];
  return { tags: tagsFor(rows.map((r) => r.slug), cats.map((c) => c.slug)), sitemap };
}

// --- mappers ------------------------------------------------------------------------------------

/** Rows → list cards (categories and covers loaded in two queries). */
export async function toItems(q: Q, rows: PostRow[]): Promise<BlogListItem[]> {
  const { blogCategories, blogAssets } = await dbm();
  const catIds = [...new Set(rows.map((r) => r.categoryId).filter((x): x is string => !!x))];
  const coverIds = [...new Set(rows.map((r) => r.coverAssetId).filter((x): x is string => !!x))];
  const [cats, assets] = await Promise.all([
    catIds.length ? q.select().from(blogCategories).where(inArray(blogCategories.id, catIds)) : [],
    coverIds.length ? q.select().from(blogAssets).where(inArray(blogAssets.id, coverIds)) : [],
  ]);
  const cat = new Map(cats.map((c) => [c.id, { id: c.id, slug: c.slug, name: c.name }]));
  const asset = new Map(assets.map((a) => [a.id, assetDto(a)]));
  return rows.map((r) => {
    const a = r.coverAssetId ? asset.get(r.coverAssetId) : undefined;
    return {
      id: r.id, slug: r.slug, title: r.title, description: r.description, excerpt: r.excerpt, template: r.template as BlogListItem['template'], status: r.status as BlogListItem['status'],
      category: (r.categoryId && cat.get(r.categoryId)) || null,
      cover: a ? { url: a.url, width: a.width, height: a.height, srcset: a.srcset, alt: r.coverAlt } : null,
      readingMinutes: r.readingMinutes, publishAt: r.publishAt, publishedAt: r.publishedAt, updatedAt: r.updatedAt,
    };
  });
}

export async function authorOf(q: Q, authorId: string | null) {
  if (!authorId) return null;
  const { profiles } = await dbm();
  const [p] = await q.select({ name: profiles.name }).from(profiles).where(eq(profiles.userId, authorId));
  return { id: authorId, name: p?.name ?? null };
}

export async function toPost(q: Q, r: PostRow): Promise<BlogPost> {
  const { blogCategories, blogAssets } = await dbm();
  const [[cat], [asset], author] = await Promise.all([
    r.categoryId ? q.select().from(blogCategories).where(eq(blogCategories.id, r.categoryId)) : [],
    r.coverAssetId ? q.select().from(blogAssets).where(eq(blogAssets.id, r.coverAssetId)) : [],
    authorOf(q, r.authorId),
  ]);
  return {
    id: r.id, slug: r.slug, title: r.title, seoTitle: r.seoTitle, description: r.description, excerpt: r.excerpt, template: r.template as BlogPost['template'], status: r.status as BlogPost['status'],
    category: cat ? { id: cat.id, slug: cat.slug, name: cat.name } : null, author,
    cover: asset ? assetDto(asset) : null, coverAlt: r.coverAlt, focusKeyword: r.focusKeyword, robots: r.robots as BlogPost['robots'], canonicalUrl: r.canonicalUrl,
    content: docOf(r), toc: r.tocJson as BlogPost['toc'], wordCount: r.wordCount, readingMinutes: r.readingMinutes,
    publishAt: r.publishAt, publishedAt: r.publishedAt, contentUpdatedAt: r.contentUpdatedAt, createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt: r.deletedAt,
  };
}

// --- helpers ------------------------------------------------------------------------------------

async function uniqueSlug(q: Q, wanted: string, exceptId?: string): Promise<string> {
  const { blogPosts } = await dbm();
  const base = (slugify(wanted) || 'post').slice(0, BLOG_LIMITS.slugMax - 4).replace(/-+$/, '');
  const rows = await q.select({ slug: blogPosts.slug }).from(blogPosts)
    .where(and(isNull(blogPosts.deletedAt), or(eq(blogPosts.slug, base), like(blogPosts.slug, `${base}-%`)), exceptId ? ne(blogPosts.id, exceptId) : undefined));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A post taking /blog/<slug> removes a stale redirect that would shadow it. */
async function claimPath(q: Q, slug: string) {
  const { blogRedirects } = await dbm();
  await q.delete(blogRedirects).where(eq(blogRedirects.fromPath, `/blog/${slug}`));
}

const imageIds = (doc: BlogDoc) => doc.content.flatMap((b: BlogBlock) => (b.type === 'image' && b.attrs.assetId ? [b.attrs.assetId] : []));

async function contentColumns(doc: BlogDoc) {
  const externals = new Map<string, { width: number; height: number }>();
  for (const b of doc.content) if (b.type === 'image' && b.attrs.src) externals.set(b.attrs.src, { width: b.attrs.width, height: b.attrs.height });
  const s = renderPostSummary(doc, { image: blogImageResolver(await loadAssets(imageIds(doc)), externals) });
  return { contentJson: doc, contentHtml: s.html, tocJson: s.toc, faq: s.faq, wordCount: s.wordCount, readingMinutes: s.readingMinutes };
}

async function saveRevision(q: Q, postId: string, title: string, doc: BlogDoc, userId: string | null) {
  const { blogRevisions } = await dbm();
  await q.insert(blogRevisions).values({ postId, title, contentJson: doc, createdBy: userId, createdAt: new Date() });
  await q.execute(sql`delete from blog_revisions where post_id = ${postId} and id not in
    (select id from blog_revisions where post_id = ${postId} order by created_at desc, id desc limit ${BLOG_LIMITS.revisions})`);
}

const lockPost = async (q: Q, id: string) => {
  const { blogPosts } = await dbm();
  const [r] = await (q as Tx).select().from(blogPosts).where(and(eq(blogPosts.id, id), isNull(blogPosts.deletedAt))).for('update');
  return r ?? null;
};
const notFound = () => err<never>('not_found', 'post not found');
const conflict = (m: string) => err<never>('conflict', m);

// --- admin reads --------------------------------------------------------------------------------

export async function listAdmin(q: Q, query: BlogAdminListQuery): Promise<BlogAdminList> {
  const { blogPosts } = await dbm();
  const p = { page: Number(query.page ?? 1), pageSize: Number(query.pageSize ?? 25), status: query.status ?? 'all', q: query.q };
  const live = isNull(blogPosts.deletedAt);
  const search: SQL | undefined = p.q ? or(sql`${blogPosts.title} ilike ${likeOf(p.q)}`, sql`${blogPosts.slug} ilike ${likeOf(p.q)}`) : undefined;
  const where = and(live, search, p.status === 'all' ? undefined : eq(blogPosts.status, p.status));
  const [rows, [t], byStatus] = await Promise.all([
    q.select().from(blogPosts).where(where).orderBy(desc(blogPosts.updatedAt), desc(blogPosts.id)).limit(p.pageSize).offset((p.page - 1) * p.pageSize),
    q.select({ n: count() }).from(blogPosts).where(where),
    q.select({ status: blogPosts.status, n: count() }).from(blogPosts).where(and(live, search)).groupBy(blogPosts.status),
  ]);
  const counts: BlogAdminList['counts'] = { all: 0, draft: 0, scheduled: 0, published: 0, archived: 0 };
  for (const s of byStatus) {
    counts[s.status as keyof typeof counts] = s.n;
    counts.all = (counts.all ?? 0) + s.n;
  }
  return { items: await toItems(q, rows), total: t?.n ?? 0, page: p.page, pageSize: p.pageSize, counts };
}

export async function getAdminPost(q: Q, id: string): Promise<BlogPost | null> {
  const { blogPosts } = await dbm();
  const [r] = await q.select().from(blogPosts).where(and(eq(blogPosts.id, id), isNull(blogPosts.deletedAt)));
  return r ? toPost(q, r) : null;
}
export async function getRow(q: Q, id: string) {
  const { blogPosts } = await dbm();
  return (await q.select().from(blogPosts).where(and(eq(blogPosts.id, id), isNull(blogPosts.deletedAt))))[0] ?? null;
}

export async function listRevisions(q: Q, postId: string) {
  const { blogRevisions, profiles } = await dbm();
  const rows = await q.select({ id: blogRevisions.id, title: blogRevisions.title, createdAt: blogRevisions.createdAt, by: blogRevisions.createdBy, name: profiles.name })
    .from(blogRevisions).leftJoin(profiles, eq(profiles.userId, blogRevisions.createdBy)).where(eq(blogRevisions.postId, postId))
    .orderBy(desc(blogRevisions.createdAt), desc(blogRevisions.id));
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, createdBy: r.by ? { id: r.by, name: r.name ?? null } : null }));
}

// --- admin writes -------------------------------------------------------------------------------

export async function createPost(tx: Tx, userId: string, id: string, input: BlogPostCreateInput): Promise<Result<{ post: BlogPost; fx: Fx }>> {
  const { blogPosts } = await dbm();
  const slug = await uniqueSlug(tx, input.title);
  await claimPath(tx, slug);
  const [row] = await tx.insert(blogPosts).values({ id, slug, title: input.title.trim(), template: input.template, createdBy: userId, authorId: null }).returning();
  return ok({ post: await toPost(tx, row!), fx: noFx });
}

type UpdateOut = { post: BlogPost; changed: string[]; fx: Fx };
const SCALARS = ['title', 'seoTitle', 'description', 'excerpt', 'template', 'categoryId', 'authorId', 'coverAssetId', 'coverAlt', 'focusKeyword', 'robots', 'canonicalUrl'] as const;

export async function updatePost(tx: Tx, userId: string, id: string, input: BlogPostInput): Promise<Result<UpdateOut>> {
  const { blogPosts, blogRedirects, blogCategories, blogAssets } = await dbm();
  const row = await lockPost(tx, id);
  if (!row) return notFound();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changed: string[] = [];
  for (const k of SCALARS) if (input[k] !== undefined && input[k] !== row[k]) {
    set[k] = input[k];
    changed.push(k);
  }
  if (input.categoryId && !(await tx.select({ id: blogCategories.id }).from(blogCategories).where(eq(blogCategories.id, input.categoryId))).length) return err('validation', 'category not found');
  if (input.coverAssetId && !(await tx.select({ id: blogAssets.id }).from(blogAssets).where(eq(blogAssets.id, input.coverAssetId))).length) return err('validation', 'cover asset not found');

  let slugFrom: string | null = null;
  if (input.slug !== undefined && input.slug !== row.slug) {
    if ((await uniqueSlug(tx, input.slug, id)) !== input.slug) return err('conflict', blogErrors.slugTaken);
    set.slug = input.slug;
    changed.push('slug');
    slugFrom = row.slug;
  }
  if (input.content !== undefined) {
    Object.assign(set, await contentColumns(input.content as BlogDoc));
    changed.push('content');
  }
  if (['title', 'description', 'content', 'coverAssetId'].some((f) => changed.includes(f))) set.contentUpdatedAt = new Date();

  const [saved] = await tx.update(blogPosts).set(set).where(eq(blogPosts.id, id)).returning();
  if (slugFrom) {
    const from = `/blog/${slugFrom}`;
    const to = `/blog/${saved!.slug}`;
    await claimPath(tx, saved!.slug);
    if (row.status === 'published') {
      await tx.update(blogRedirects).set({ toPath: to }).where(eq(blogRedirects.toPath, from)); // no chains
      await tx.insert(blogRedirects).values({ fromPath: from, toPath: to }).onConflictDoUpdate({ target: blogRedirects.fromPath, set: { toPath: to } });
    }
  }
  if (input.content !== undefined) await saveRevision(tx, id, saved!.title, input.content as BlogDoc, userId);

  const live = row.status === 'published' && changed.length > 0;
  const fx = live ? await fxFor(tx, [row, saved!], !!slugFrom) : noFx;
  return ok({ post: await toPost(tx, saved!), changed, fx });
}

export async function duplicatePost(tx: Tx, userId: string, id: string): Promise<Result<{ post: BlogPost; fx: Fx }>> {
  const { blogPosts } = await dbm();
  const src = await lockPost(tx, id);
  if (!src) return notFound();
  const title = `${src.title.slice(0, BLOG_LIMITS.titleMax - 9)} (cópia)`;
  const slug = await uniqueSlug(tx, title);
  await claimPath(tx, slug);
  const rest: Partial<PostRow> = { ...src };
  delete rest.id; delete rest.createdAt; delete rest.updatedAt;
  const [row] = await tx.insert(blogPosts).values({
    ...rest, title, slug, status: 'draft', publishAt: null, publishedAt: null, deletedAt: null, createdBy: userId, contentUpdatedAt: new Date(),
  }).returning();
  return ok({ post: await toPost(tx, row!), fx: noFx });
}

export async function publishPost(tx: Tx, id: string): Promise<Result<{ post: BlogPost; fx: Fx }>> {
  const { blogPosts } = await dbm();
  const row = await lockPost(tx, id);
  if (!row) return notFound();
  if (row.status === 'published') return conflict('already published');
  if (blockersOf(row).length) return err('validation', blogErrors.publishBlocked);
  const [saved] = await tx.update(blogPosts).set({ status: 'published', publishedAt: row.publishedAt ?? new Date(), publishAt: null, updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
  return ok({ post: await toPost(tx, saved!), fx: await fxFor(tx, [saved!], true) });
}

export async function schedulePost(tx: Tx, id: string, publishAt: Date): Promise<Result<{ post: BlogPost; fx: Fx }>> {
  const { blogPosts } = await dbm();
  const row = await lockPost(tx, id);
  if (!row) return notFound();
  if (row.status === 'published') return conflict('already published');
  if (publishAt.getTime() <= Date.now()) return err('validation', blogErrors.scheduleInPast);
  if (blockersOf(row).length) return err('validation', blogErrors.publishBlocked);
  const [saved] = await tx.update(blogPosts).set({ status: 'scheduled', publishAt, updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
  return ok({ post: await toPost(tx, saved!), fx: noFx });
}

export async function unpublishPost(tx: Tx, id: string): Promise<Result<{ post: BlogPost; fx: Fx }>> {
  const { blogPosts } = await dbm();
  const row = await lockPost(tx, id);
  if (!row) return notFound();
  if (row.status !== 'published' && row.status !== 'scheduled') return conflict('not published');
  const [saved] = await tx.update(blogPosts).set({ status: 'archived', publishAt: null, updatedAt: new Date() }).where(eq(blogPosts.id, id)).returning();
  return ok({ post: await toPost(tx, saved!), fx: row.status === 'published' ? await fxFor(tx, [saved!], true) : noFx });
}

export async function deletePost(tx: Tx, id: string): Promise<Result<{ fx: Fx; before: { status: string; slug: string } }>> {
  const { blogPosts } = await dbm();
  const row = await lockPost(tx, id);
  if (!row) return notFound();
  await tx.update(blogPosts).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(blogPosts.id, id));
  return ok({ fx: row.status === 'published' ? await fxFor(tx, [row], true) : noFx, before: { status: row.status, slug: row.slug } });
}

export async function restoreRevision(tx: Tx, userId: string, postId: string, revisionId: string): Promise<Result<UpdateOut>> {
  const { blogRevisions } = await dbm();
  const [rev] = await tx.select().from(blogRevisions).where(and(eq(blogRevisions.id, revisionId), eq(blogRevisions.postId, postId)));
  if (!rev) return err('not_found', 'revision not found');
  return updatePost(tx, userId, postId, { content: rev.contentJson as unknown as BlogDoc });
}

// --- categories ---------------------------------------------------------------------------------

export async function listCategories(q: Q, opts: { publicOnly?: boolean } = {}): Promise<BlogCategory[]> {
  const { blogCategories, blogPosts } = await dbm();
  const [cats, counts] = await Promise.all([
    q.select().from(blogCategories).orderBy(asc(blogCategories.position), asc(blogCategories.name)),
    q.select({ id: blogPosts.categoryId, n: count() }).from(blogPosts).where(and(isNull(blogPosts.deletedAt), eq(blogPosts.status, 'published'), eq(blogPosts.robots, 'index'))).groupBy(blogPosts.categoryId),
  ]);
  const n = new Map(counts.map((c) => [c.id, c.n]));
  return cats.map((c) => ({
    id: c.id, slug: c.slug, name: c.name, intro: opts.publicOnly && c.introDraft ? '' : c.intro, introDraft: c.introDraft, position: c.position, postCount: n.get(c.id) ?? 0,
  }));
}

export async function upsertCategory(tx: Tx, id: string, input: BlogCategoryInput & { name: string }): Promise<Result<{ category: BlogCategory; fx: Fx; created: boolean }>> {
  const { blogCategories } = await dbm();
  const [cur] = input.id ? await tx.select().from(blogCategories).where(eq(blogCategories.id, input.id)) : [];
  if (input.id && !cur) return err('not_found', 'category not found');
  const wanted = input.slug ?? (cur ? cur.slug : slugify(input.name));
  const clash = await tx.select({ id: blogCategories.id }).from(blogCategories).where(and(eq(blogCategories.slug, wanted), cur ? ne(blogCategories.id, cur.id) : undefined));
  let slug = wanted;
  if (clash.length) {
    if (input.slug || cur) return err('conflict', blogErrors.slugTaken);
    const rows = await tx.select({ slug: blogCategories.slug }).from(blogCategories).where(like(blogCategories.slug, `${wanted}-%`));
    const taken = new Set(rows.map((r) => r.slug));
    let k = 2;
    while (taken.has(`${wanted}-${k}`)) k++;
    slug = `${wanted}-${k}`;
  }
  if (!slug) return err('validation', 'slug');
  const values = { name: input.name.trim(), slug, intro: input.intro ?? '', introDraft: input.introDraft ?? false, updatedAt: new Date() };
  if (cur) {
    const [row] = await tx.update(blogCategories).set({ ...values, position: input.position ?? cur.position }).where(eq(blogCategories.id, cur.id)).returning();
    return ok({ category: (await listCategories(tx)).find((c) => c.id === row!.id)!, fx: { tags: tagsFor([], [cur.slug, slug]), sitemap: cur.slug !== slug }, created: false });
  }
  const [max] = await tx.select({ m: sql<number>`coalesce(max(${blogCategories.position}), -1)` }).from(blogCategories);
  const [row] = await tx.insert(blogCategories).values({ id, ...values, position: input.position ?? (max?.m ?? -1) + 1 }).returning();
  return ok({ category: (await listCategories(tx)).find((c) => c.id === row!.id)!, fx: { tags: tagsFor([], [slug]), sitemap: true }, created: true });
}
