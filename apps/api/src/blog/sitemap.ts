// F27 FR-31–FR-33 (D-916, D-925): blog part of the sitemap. The web adds SITEMAP_STATIC_PATHS and renders the XML.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SITEMAP_STATIC_PATHS, type SitemapEntry, type SitemapStatus } from '@remoa/contracts';
import { createLogger, newRequestId } from '@remoa/log';
import type { Tx } from '@remoa/db';
import { dbm } from '../db';
import { invalidate } from '../cache';

type Exec = Pick<Tx, 'execute'>;
type Row = { path: string; kind: 'category' | 'post'; lastmod: Date | string };

/** Indexable = published, robots index, not deleted. Same rule for posts and for "category has at least one post". */
const INDEXABLE = sql.raw(`p.status = 'published' and p.robots = 'index' and p.deleted_at is null`);

/** Sorted by path. Post lastmod = greatest(content_updated_at, published_at); category = its newest indexable post. */
export async function buildBlogSitemap(db: Exec): Promise<SitemapEntry[]> {
  const rows = await db.execute<Row>(sql`
    select '/blog/' || p.slug as path, 'post' as kind, greatest(p.content_updated_at, p.published_at) as lastmod
    from blog_posts p where ${INDEXABLE}
    union all
    select '/blog/categoria/' || c.slug, 'category', max(greatest(p.content_updated_at, p.published_at))
    from blog_categories c join blog_posts p on p.category_id = c.id and ${INDEXABLE}
    group by c.slug
    order by 1`);
  return rows.map((r) => ({ path: r.path, kind: r.kind, lastmod: new Date(r.lastmod) }));
}

/** sha256 of the sorted "path lastmod" lines: same posts and dates = same hash, whatever the query order. */
export const sitemapHash = (entries: SitemapEntry[]) =>
  createHash('sha256').update(entries.map((e) => `${e.path} ${e.lastmod.toISOString()}`).sort().join('\n')).digest('hex');

/** Next 06:00 UTC (03:00 in Brasília) strictly after `now`: when sitemap.daily runs. */
export function nextSitemapRun(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const total = (entries: SitemapEntry[]) => entries.length + SITEMAP_STATIC_PATHS.length; // D-916

async function lastSnapshot(db: Exec) {
  const [s] = await db.execute<{ generated_at: Date | string; hash: string }>(sql`select generated_at, hash from sitemap_snapshots order by generated_at desc limit 1`);
  return s ? { at: new Date(s.generated_at), hash: s.hash } : null;
}

/** Admin "Ver URLs" (GET /v1/admin/blog/sitemap): live count + last snapshot. */
export async function getAdminSitemap(now = new Date()): Promise<{ status: SitemapStatus; entries: SitemapEntry[] }> {
  const { db } = await dbm();
  const [entries, snap] = await Promise.all([buildBlogSitemap(db), lastSnapshot(db)]);
  return { status: { urlCount: total(entries), lastGeneratedAt: snap?.at ?? null, nextRunAt: nextSitemapRun(now), hash: snap?.hash ?? null }, entries };
}

export const getSitemapStatus = async (now = new Date()): Promise<SitemapStatus> => (await getAdminSitemap(now)).status;

/**
 * FR-33: rebuild, and write a snapshot + revalidate the web's `sitemap` tag only when the hash changed (or `force`).
 * An advisory lock serializes concurrent runs (cron + publish), so one change never yields two snapshots.
 */
export async function regenerateSitemap(opts: { force?: boolean; reason?: string } = {}, now = new Date()): Promise<SitemapStatus> {
  const { db } = await dbm();
  const log = createLogger({ requestId: newRequestId() });
  const r = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('remoa.sitemap'))`);
    const entries = await buildBlogSitemap(tx);
    const hash = sitemapHash(entries);
    const prev = await lastSnapshot(tx);
    const changed = prev?.hash !== hash;
    if (!changed && !opts.force) return { entries, hash, changed, at: prev!.at };
    const [s] = await tx.execute<{ generated_at: Date | string }>(sql`insert into sitemap_snapshots (url_count, hash) values (${total(entries)}, ${hash}) returning generated_at`);
    return { entries, hash, changed, at: new Date(s!.generated_at) };
  });
  log.info('sitemap regenerated', { reason: opts.reason ?? null, force: !!opts.force, changed: r.changed, urlCount: total(r.entries), hash: r.hash });
  if (r.changed || opts.force) await invalidate('blog.changed', {}, log); // the catalog's blog.changed always carries the `sitemap` tag
  return { urlCount: total(r.entries), lastGeneratedAt: r.at, nextRunAt: nextSitemapRun(now), hash: r.hash };
}
