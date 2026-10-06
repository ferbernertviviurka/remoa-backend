// G19 F27 /v1/public/blog/*: no auth. Reads only `published`, never deleted. List, latest, feed, related and sitemap also need robots = index (D-908).
import { Hono } from 'hono';
import { and, desc, eq, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  BLOG_LIMITS, blogPublicListQuerySchema, err, errorHttpStatus, idSchema, ok, parseWith, type BlogPublicPost, type HttpErrorBody, type Result,
} from '@remoa/contracts';
import { dbm } from '../db';
import { likeOf } from '../admin/users/util';
import { assetDto } from './images';
import { getPublicObject } from '../storage/storage';
import { verifyPreview } from './preview';
import { buildBlogSitemap } from './sitemap';
import { authorOf, listCategories, toItems, type PostRow, type Q } from './posts';

const send = <T>(r: Result<T>, cache = 'public, max-age=60, stale-while-revalidate=300') =>
  r.ok ? Response.json({ ok: true, data: r.data }, { headers: { 'cache-control': cache } })
    : Response.json({ error: r.error } satisfies HttpErrorBody, { status: errorHttpStatus[r.error.code], ...(cache === 'no-store' ? { headers: { 'cache-control': cache } } : {}) });
const gone = () => err<never>('not_found', 'not found');
/** Only keys written by the blog image pipeline (images.ts); the bucket may also hold private user files. */
export const BLOG_FILE_KEY = /^blog\/[0-9a-f-]{36}\/[a-z0-9-]*-(?:\d+\.(?:webp|avif)|og\.jpg)$/;

const published = async () => {
  const { blogPosts: p } = await dbm();
  return and(eq(p.status, 'published'), isNull(p.deletedAt));
};
const indexed = async () => {
  const { blogPosts: p } = await dbm();
  return and(await published(), eq(p.robots, 'index'));
};

async function related(q: Q, row: PostRow) {
  const { blogPosts: p } = await dbm();
  const base = and(await indexed(), ne(p.id, row.id));
  const same = row.categoryId
    ? await q.select().from(p).where(and(base, eq(p.categoryId, row.categoryId))).orderBy(desc(p.publishedAt)).limit(BLOG_LIMITS.related)
    : [];
  const rest = same.length < BLOG_LIMITS.related
    ? await q.select().from(p).where(and(base, notInArray(p.id, [row.id, ...same.map((r) => r.id)]))).orderBy(desc(p.publishedAt)).limit(BLOG_LIMITS.related - same.length)
    : [];
  return toItems(q, [...same, ...rest]);
}

export async function toPublicPost(q: Q, row: PostRow, preview: boolean): Promise<BlogPublicPost> {
  const { blogCategories, blogAssets } = await dbm();
  const [[cat], [asset], author, rel] = await Promise.all([
    row.categoryId ? q.select().from(blogCategories).where(eq(blogCategories.id, row.categoryId)) : [],
    row.coverAssetId ? q.select().from(blogAssets).where(eq(blogAssets.id, row.coverAssetId)) : [],
    authorOf(q, row.authorId),
    related(q, row),
  ]);
  const cover = asset ? assetDto(asset) : null;
  return {
    id: row.id, slug: row.slug, title: row.title, seoTitle: row.seoTitle, description: row.description, excerpt: row.excerpt, template: row.template as BlogPublicPost['template'],
    category: cat ? { id: cat.id, slug: cat.slug, name: cat.name } : null, author,
    cover: cover && { url: cover.url, width: cover.width, height: cover.height, srcset: cover.srcset, id: cover.id, mime: cover.mime, size: cover.size, ogUrl: cover.ogUrl },
    coverAlt: row.coverAlt, robots: row.robots as BlogPublicPost['robots'], canonicalUrl: row.canonicalUrl, toc: row.tocJson as BlogPublicPost['toc'],
    wordCount: row.wordCount, readingMinutes: row.readingMinutes, publishedAt: row.publishedAt, contentUpdatedAt: row.contentUpdatedAt,
    html: row.contentHtml, faq: row.faq as BlogPublicPost['faq'], related: rel, preview,
  };
}

export const publicBlogRoutes = new Hono()
  .get('/posts', async (c) => {
    const query = parseWith(blogPublicListQuerySchema, c.req.query());
    if (!query.ok) return send(query);
    const { page, category, q: text } = query.data;
    const { db, blogPosts: p, blogCategories } = await dbm();
    const [cat] = category ? await db.select({ id: blogCategories.id }).from(blogCategories).where(eq(blogCategories.slug, category)) : [];
    if (category && !cat) return send(ok({ items: [], total: 0, page, pageSize: BLOG_LIMITS.pageSize }));
    const where = and(await indexed(), cat ? eq(p.categoryId, cat.id) : undefined,
      text ? or(sql`${p.title} ilike ${likeOf(text)}`, sql`${p.description} ilike ${likeOf(text)}`) : undefined);
    const [rows, [t]] = await Promise.all([
      db.select().from(p).where(where).orderBy(desc(p.publishedAt), desc(p.id)).limit(BLOG_LIMITS.pageSize).offset((page - 1) * BLOG_LIMITS.pageSize),
      db.select({ n: sql<number>`count(*)::int` }).from(p).where(where),
    ]);
    return send(ok({ items: await toItems(db, rows), total: t?.n ?? 0, page, pageSize: BLOG_LIMITS.pageSize }));
  })
  .get('/posts/latest', async (c) => {
    const n = Math.min(Math.max(Math.trunc(Number(c.req.query('n') ?? BLOG_LIMITS.latest)) || BLOG_LIMITS.latest, 1), BLOG_LIMITS.latest);
    const { db, blogPosts: p } = await dbm();
    return send(ok(await toItems(db, await db.select().from(p).where(await indexed()).orderBy(desc(p.publishedAt), desc(p.id)).limit(n))));
  })
  .get('/posts/:slug', async (c) => {
    const slug = c.req.param('slug');
    const { db, blogPosts: p, blogRedirects } = await dbm();
    const [row] = await db.select().from(p).where(and(await published(), eq(p.slug, slug)));
    if (row) return send(ok({ kind: 'post' as const, post: await toPublicPost(db, row, false) }));
    const [r] = await db.select().from(blogRedirects).where(eq(blogRedirects.fromPath, `/blog/${slug}`));
    return r ? send(ok({ kind: 'redirect' as const, to: r.toPath })) : send(gone());
  })
  .get('/categories', async () => send(ok(await listCategories((await dbm()).db, { publicOnly: true }))))
  .get('/categories/:slug', async (c) => {
    const cat = (await listCategories((await dbm()).db, { publicOnly: true })).find((x) => x.slug === c.req.param('slug'));
    return send(cat ? ok(cat) : gone());
  })
  .get('/feed', async () => {
    const { db, blogPosts: p } = await dbm();
    return send(ok(await toItems(db, await db.select().from(p).where(await indexed()).orderBy(desc(p.publishedAt), desc(p.id)).limit(BLOG_LIMITS.rssItems))));
  })
  .get('/sitemap', async () => send(ok(await buildBlogSitemap((await dbm()).db))))
  // Blog images when the bucket is private (R2_PUBLIC_BASE_URL = <api>/v1/public/blog/files).
  // ponytail: every image read goes through the API; put a CDN in front if blog traffic grows.
  .get('/files/*', async (c) => {
    const key = decodeURIComponent(c.req.path.slice(c.req.path.indexOf('/files/') + '/files/'.length));
    const file = BLOG_FILE_KEY.test(key) ? await getPublicObject(key) : null;
    if (!file) return send(gone(), 'no-store');
    return new Response(new Uint8Array(file.body), { headers: { 'content-type': file.mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  })
  // FR-10: any status, never cached, never indexed.
  .get('/preview/:token', async (c) => {
    const id = verifyPreview(c.req.param('token'));
    if (!id || !idSchema.safeParse(id).success) return send(gone(), 'no-store');
    const { db, blogPosts: p } = await dbm();
    const [row] = await db.select().from(p).where(and(eq(p.id, id), isNull(p.deletedAt)));
    return row ? send(ok(await toPublicPost(db, row, true)), 'private, no-store') : send(gone(), 'no-store');
  });
