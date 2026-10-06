// F27 jobs (FR-33, FR-34, D-926/D-927): spread into noticeJobs, so Inngest and POST /v1/cron/:job run the same bodies.
import { sql } from 'drizzle-orm';
import { BLOG_JOBS, type BlogJob } from '@remoa/contracts';
import { env } from '@remoa/config';
import { createLogger, newRequestId } from '@remoa/log';
import { dbm } from '../db';
import { invalidate } from '../cache';
import { regenerateSitemap } from '../blog/sitemap';

const CLEANUP_DAYS = 30;
/** An upload not yet saved into a post (autosave ~5 s) is not an orphan: only assets older than this are swept. */
const ORPHAN_GRACE_HOURS = 24;

/**
 * FR-34: publish scheduled posts that are due. One UPDATE … WHERE status = 'scheduled' … RETURNING: a concurrent run blocks on
 * the row lock, re-checks the WHERE and gets nothing, so a post is published (and audited) exactly once.
 */
export async function publishScheduled(now: Date) {
  const { db } = await dbm();
  const rows = await db.transaction(async (tx) => {
    const done = await tx.execute<{ id: string; slug: string; publish_at: Date | string; category_slug: string | null }>(sql`
      with p as (
        update blog_posts set status = 'published', published_at = publish_at, updated_at = now()
        where status = 'scheduled' and publish_at <= ${now.toISOString()}::timestamptz and deleted_at is null
        returning id, slug, publish_at, category_id)
      select p.id, p.slug, p.publish_at, c.slug as category_slug from p left join blog_categories c on c.id = p.category_id`);
    for (const p of done) {
      const at = new Date(p.publish_at).toISOString();
      await tx.execute(sql`insert into admin_audit_log (actor_type, action, target_type, target_id, reason, result, before, after)
        values ('system', 'blog.auto_publish', 'blog_post', ${p.id}, 'publicação agendada do blog', 'success',
          ${JSON.stringify({ status: 'scheduled', publishAt: at })}::jsonb, ${JSON.stringify({ status: 'published', publishedAt: at })}::jsonb)`);
    }
    return done;
  });
  if (rows.length) {
    const log = createLogger({ requestId: newRequestId() });
    log.info('blog scheduled posts published', { count: rows.length, slugs: rows.map((r) => r.slug) });
    await invalidate('blog.changed', { slugs: rows.map((r) => r.slug), categorySlugs: rows.flatMap((r) => (r.category_slug ? [r.category_slug] : [])) }, log);
    await regenerateSitemap({ reason: 'blog.publish-scheduled' }, now);
  }
  return { published: rows.length };
}

/**
 * Purge posts deleted more than 30 days ago (revisions cascade), then blog assets no post or revision mentions any more
 * (cover, image assetId or public URL: all contain the asset id). Objects go before rows, so a failed bucket call is retried next day.
 */
export async function cleanupBlog(now: Date) {
  const { db } = await dbm();
  const at = now.toISOString();
  const posts = await db.execute(sql`delete from blog_posts where deleted_at < ${at}::timestamptz - make_interval(days => ${CLEANUP_DAYS})`);
  const orphans = await db.execute<{ id: string }>(sql`
    select a.id from blog_assets a
    where a.created_at < ${at}::timestamptz - make_interval(hours => ${ORPHAN_GRACE_HOURS})
      and not exists (select 1 from blog_posts p where p.cover_asset_id = a.id or p.content_json::text like '%' || a.id::text || '%')
      and not exists (select 1 from blog_revisions r where r.content_json::text like '%' || a.id::text || '%')`);
  let assets = 0;
  if (orphans.length) {
    const { deletePrefix } = await import('../storage/storage');
    const bucket = env().s3PublicBucket;
    for (const { id } of orphans) {
      await deletePrefix(`blog/${id}/`, bucket);
      await db.execute(sql`delete from blog_assets where id = ${id}`);
      assets++;
    }
  }
  return { posts: posts.count, assets };
}

export const blogJobs = {
  'sitemap.daily': { cron: BLOG_JOBS['sitemap.daily'], run: (now: Date) => regenerateSitemap({ reason: 'sitemap.daily' }, now) },
  'blog.publish-scheduled': { cron: BLOG_JOBS['blog.publish-scheduled'], run: publishScheduled },
  'blog.cleanup': { cron: BLOG_JOBS['blog.cleanup'], run: cleanupBlog },
} as const satisfies Record<BlogJob, { cron: string; run: (now: Date) => Promise<unknown> }>;
