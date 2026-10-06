// G19 F27 /v1/admin/blog/* (D-908–D-910). Mounted by routes/admin.ts under requireAdmin; every write goes through withAdmin (rule 9).
// Side effects (revalidation, sitemap) run after the commit and never fail the request.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  BLOG_AUTO_REASONS, BLOG_LIMITS, blogAdminListQuerySchema, blogCategoryInputSchema, blogErrors, blogPostCreateInputSchema, blogPostInputSchema, blogScheduleInputSchema,
  err, idSchema, ok, parseWith, slugify, type AuditEntry, type Result,
} from '@remoa/contracts';
import { dbm } from '../db';
import { notFound, reasonOf, send, withAdmin, type AdminEnv } from '../admin/core';
import { uploadBlogImage } from './images';
import { signPreview } from './preview';
import { revalidateBlog } from './revalidate';
import { getAdminSitemap, regenerateSitemap } from './sitemap';
import {
  blockersOf, createPost, deletePost, duplicatePost, getAdminPost, getRow, listAdmin, listCategories, listRevisions, publishPost, restoreRevision, schedulePost, unpublishPost,
  updatePost, upsertCategory, type Fx,
} from './posts';

type C = Context<AdminEnv>;
const R = BLOG_AUTO_REASONS;
const json = (c: C) => c.req.json().catch(() => null) as Promise<unknown>;
const isId = (v: string | undefined): v is string => idSchema.safeParse(v).success;
const AUTO = { sensitive: false } as const;

async function after(c: C, fx: Fx, why: string) {
  const log = c.get('log');
  if (fx.tags.length) await revalidateBlog(fx.tags).catch((e) => log.error('blog revalidate failed', { error: String(e) }));
  if (fx.sitemap) await regenerateSitemap({ reason: why }).catch((e) => log.error('blog sitemap failed', { error: String(e) }));
}

/** { post, audit } response after running the effects. */
async function done<T extends { fx: Fx }>(c: C, r: Result<T & { audit: AuditEntry }>, why: string, shape: (d: T) => object) {
  if (!r.ok) return send(r);
  await after(c, r.data.fx, why);
  return send(ok({ ...shape(r.data), audit: r.data.audit }));
}

export const blogAdminRoutes = new Hono<AdminEnv>()
  .get('/posts', async (c) => {
    const q = parseWith(blogAdminListQuerySchema, c.req.query());
    return send(q.ok ? ok(await listAdmin((await dbm()).db, q.data)) : q);
  })
  .post('/posts', async (c) => {
    const body = parseWith(blogPostCreateInputSchema, await json(c));
    if (!body.ok) return send(body);
    const id = crypto.randomUUID();
    const r = await withAdmin(c, 'blog.create', { reason: R.create, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await createPost(tx, c.get('admin').id, id, body.data);
      if (res.ok) audit.after({ slug: res.data.post.slug, template: body.data.template });
      return res;
    });
    return done(c, r, 'create', (d) => ({ post: d.post }));
  })
  .get('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const post = isId(id) ? await getAdminPost((await dbm()).db, id) : null;
    return post ? send(ok(post)) : notFound();
  })
  .patch('/posts/:id', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const body = parseWith(blogPostInputSchema, await json(c));
    if (!body.ok) return send(body);
    const r = await withAdmin(c, 'blog.update', { reason: R.update, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await updatePost(tx, c.get('admin').id, id, body.data);
      if (res.ok) audit.after({ fields: res.data.changed }); // D-910: field names only, never the text
      return res;
    });
    return done(c, r, 'update', (d) => ({ post: d.post }));
  })
  .post('/posts/:id/duplicate', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const r = await withAdmin(c, 'blog.duplicate', { reason: R.duplicate, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await duplicatePost(tx, c.get('admin').id, id);
      if (res.ok) audit.after({ id: res.data.post.id, slug: res.data.post.slug });
      return res;
    });
    return done(c, r, 'duplicate', (d) => ({ post: d.post }));
  })
  .post('/posts/:id/publish', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const r = await withAdmin(c, 'blog.publish', { reason: R.publish, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await publishPost(tx, id);
      if (res.ok) audit.after({ status: 'published', slug: res.data.post.slug });
      return res;
    });
    if (!r.ok && r.error.message === blogErrors.publishBlocked) return blocked(r.error, id);
    return done(c, r, 'publish', (d) => ({ post: d.post }));
  })
  .post('/posts/:id/schedule', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const body = parseWith(blogScheduleInputSchema, await json(c));
    if (!body.ok) return send(body);
    const r = await withAdmin(c, 'blog.schedule', { reason: R.schedule, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await schedulePost(tx, id, body.data.publishAt);
      if (res.ok) audit.after({ status: 'scheduled', publishAt: body.data.publishAt });
      return res;
    });
    if (!r.ok && r.error.message === blogErrors.publishBlocked) return blocked(r.error, id);
    return done(c, r, 'schedule', (d) => ({ post: d.post }));
  })
  .post('/posts/:id/unpublish', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const body = await json(c);
    const r = await withAdmin(c, 'blog.unpublish', { reason: reasonOf(body), target: { type: 'blog_post', id } }, async (tx, audit) => {
      const before = await getRow(tx, id);
      const res = await unpublishPost(tx, id);
      if (res.ok) {
        audit.before({ status: before?.status });
        audit.after({ status: 'archived' });
      }
      return res;
    });
    return done(c, r, 'unpublish', (d) => ({ post: d.post }));
  })
  .delete('/posts/:id', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const body = await json(c);
    const r = await withAdmin(c, 'blog.delete', { reason: reasonOf(body), target: { type: 'blog_post', id } }, async (tx, audit) => {
      const res = await deletePost(tx, id);
      if (res.ok) {
        audit.before(res.data.before);
        audit.after({ deleted: true });
      }
      return res;
    });
    return done(c, r, 'delete', () => ({}));
  })
  .get('/posts/:id/revisions', async (c) => {
    const id = c.req.param('id');
    const { db } = await dbm();
    return isId(id) && (await getRow(db, id)) ? send(ok(await listRevisions(db, id))) : notFound();
  })
  .post('/posts/:id/revisions/:revisionId/restore', async (c) => {
    const id = c.req.param('id');
    const rev = c.req.param('revisionId');
    if (!isId(id) || !isId(rev)) return notFound();
    const r = await withAdmin(c, 'blog.restore_revision', { reason: R.restore, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      const res = await restoreRevision(tx, c.get('admin').id, id, rev);
      if (res.ok) audit.after({ revisionId: rev, fields: res.data.changed });
      return res;
    });
    return done(c, r, 'restore', (d) => ({ post: d.post }));
  })
  .post('/posts/:id/preview', async (c) => {
    const id = c.req.param('id');
    if (!isId(id)) return notFound();
    const r = await withAdmin(c, 'blog.preview_link', { reason: R.preview, target: { type: 'blog_post', id }, ...AUTO }, async (tx, audit) => {
      if (!(await getRow(tx, id))) return err<never>('not_found', 'post not found');
      const link = signPreview(id);
      audit.after({ expiresAt: link.expiresAt }); // never the token
      return ok({ link });
    });
    return r.ok ? send(ok({ ...r.data.link, audit: r.data.audit })) : send(r);
  })
  // bodyLimit also counts a chunked body (no content-length) while it streams, so an oversized upload is cut before it is buffered.
  .post('/images', bodyLimit({ maxSize: BLOG_LIMITS.imageMaxBytes + 64 * 1024, onError: () => send(err('validation', blogErrors.badImage)) }), async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    const slug = form?.get('slug');
    if (!(file instanceof File) || typeof slug !== 'string' || !slugify(slug)) return send(err('validation', blogErrors.badImage));
    if (file.size > BLOG_LIMITS.imageMaxBytes) return send(err('validation', blogErrors.badImage));
    const bytes = Buffer.from(await file.arrayBuffer());
    const id = crypto.randomUUID();
    const r = await withAdmin(c, 'blog.upload_image', { reason: R.upload, target: { type: 'blog_asset', id }, ...AUTO }, async (tx, audit) => {
      const res = await uploadBlogImage(c.get('admin').id, { bytes, slug, id }, tx);
      if (res.ok) audit.after({ assetId: id, width: res.data.asset.width, height: res.data.asset.height, size: bytes.length });
      return res;
    });
    return send(r);
  })
  .get('/categories', async () => send(ok(await listCategories((await dbm()).db))))
  .post('/categories', async (c) => {
    const body = parseWith(blogCategoryInputSchema, await json(c));
    if (!body.ok) return send(body);
    const id = body.data.id ?? crypto.randomUUID();
    const r = await withAdmin(c, 'blog.category_upsert', { reason: R.category, target: { type: 'blog_category', id }, ...AUTO }, async (tx, audit) => {
      const res = await upsertCategory(tx, id, body.data);
      if (res.ok) audit.after({ slug: res.data.category.slug, created: res.data.created });
      return res;
    });
    return done(c, r, 'category', (d) => ({ category: d.category }));
  })
  .get('/sitemap', async () => {
    return send(ok(await getAdminSitemap()));
  })
  .post('/sitemap/regenerate', async (c) => {
    const r = await withAdmin(c, 'sitemap.regenerate', { reason: R.sitemap, target: { type: 'sitemap', id: 'sitemap' }, ...AUTO }, async (_tx, audit) => {
      const status = await regenerateSitemap({ force: true, reason: 'admin' });
      audit.after({ urlCount: status.urlCount, hash: status.hash });
      return ok({ status });
    });
    return send(r);
  });

/** publish_blocked + the list (extra field; the contract's message stays `publish_blocked`). */
async function blocked(error: { code: 'validation'; message: string } | { code: string; message: string }, id: string) {
  const row = await getRow((await dbm()).db, id);
  return Response.json({ error, blockers: row ? blockersOf(row) : [] }, { status: 422 });
}
