import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nextSitemapRun, sitemapHash } from '../blog/sitemap';

config({ path: '../../.env' });
const DAY = 86_400_000;

const revalidate = vi.hoisted(() => vi.fn<(tags: string[], log?: unknown) => Promise<void>>(async () => {}));
const deletePrefix = vi.hoisted(() => vi.fn<(prefix: string, bucket?: string) => Promise<number>>(async () => 1));
vi.mock('../blog/revalidate', () => ({ revalidateBlog: revalidate }));
vi.mock('../storage/storage', () => ({ deletePrefix }));

describe('sitemap helpers', () => {
  it('next run is the next 06:00 UTC (03:00 in Brasília)', () => {
    expect(nextSitemapRun(new Date('2026-10-05T05:59:59Z')).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(nextSitemapRun(new Date('2026-10-05T06:00:00Z')).toISOString()).toBe('2026-10-06T06:00:00.000Z');
    expect(nextSitemapRun(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  it('hash is stable across order and changes with a lastmod', () => {
    const a = { path: '/blog/a', kind: 'post' as const, lastmod: new Date('2026-10-01T00:00:00Z') };
    const b = { path: '/blog/b', kind: 'post' as const, lastmod: new Date('2026-10-02T00:00:00Z') };
    expect(sitemapHash([a, b])).toBe(sitemapHash([b, a]));
    expect(sitemapHash([a, b])).not.toBe(sitemapHash([a, { ...b, lastmod: new Date('2026-10-03T00:00:00Z') }]));
    expect(sitemapHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('blog sitemap and jobs (DB)', () => {
  let dbm: typeof import('@remoa/db');
  let sm: typeof import('../blog/sitemap');
  let jobs: typeof import('./blog');
  const run = uuid().slice(0, 8);
  const slug = (s: string) => `t3-${s}-${run}`;
  const cat = uuid();
  const emptyCat = uuid();
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();

  const post = (s: string, f: { status?: string; robots?: string; deleted?: string | null; publishAt?: string | null; category?: string; cover?: string } = {}) => {
    const status = f.status ?? 'published';
    return dbm.db.execute(sql`insert into blog_posts (slug, title, status, robots, category_id, published_at, publish_at, deleted_at, content_updated_at, cover_asset_id)
      values (${slug(s)}, ${s}, ${status}, ${f.robots ?? 'index'}, ${f.category ?? cat}, ${status === 'published' ? ago(2) : null}::timestamptz,
        ${f.publishAt ?? null}::timestamptz, ${f.deleted ?? null}::timestamptz, ${ago(3)}::timestamptz, ${f.cover ?? null})`);
  };
  const statusOf = async (s: string) => (await dbm.db.execute<{ status: string }>(sql`select status from blog_posts where slug = ${slug(s)}`))[0]?.status;

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    sm = await import('../blog/sitemap');
    jobs = await import('./blog');
    await dbm.db.execute(sql`insert into blog_categories (id, slug, name) values (${cat}, ${slug('cat')}, 'T3'), (${emptyCat}, ${slug('empty')}, 'T3 vazia')`);
    await post('pub');
    await post('noindex', { robots: 'noindex' });
    await post('draft', { status: 'draft' });
    await post('archived', { status: 'archived' });
    await post('sched-future', { status: 'scheduled', publishAt: new Date(now.getTime() + DAY).toISOString() });
    await post('deleted', { deleted: ago(1) });
    await post('draft-only', { status: 'draft', category: emptyCat });
  });
  afterAll(async () => {
    await dbm.db.execute(sql`delete from blog_posts where slug like ${`t3-%-${run}`}`);
    await dbm.db.execute(sql`delete from blog_categories where id in (${cat}, ${emptyCat})`);
    await dbm.db.execute(sql`delete from blog_assets where key like ${`blog/t3-${run}/%`}`);
  });

  it('lists only published + index + live posts, and categories that have one', async () => {
    const paths = (await sm.buildBlogSitemap(dbm.db)).map((e) => e.path);
    expect(paths).toContain(`/blog/${slug('pub')}`);
    expect(paths).toContain(`/blog/categoria/${slug('cat')}`);
    for (const s of ['noindex', 'draft', 'archived', 'sched-future', 'deleted', 'draft-only']) expect(paths).not.toContain(`/blog/${slug(s)}`);
    expect(paths).not.toContain(`/blog/categoria/${slug('empty')}`);
    expect(paths).toEqual([...paths].sort());
    for (const p of paths) expect(p).toMatch(/^\/blog\/(categoria\/)?[a-z0-9-]+$/);
  });

  it('writes a snapshot only when the list changed (or force) and then revalidates', async () => {
    const count = async () => Number((await dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from sitemap_snapshots`))[0]!.n);
    const first = await sm.regenerateSitemap({ reason: 'test' });
    const n = await count();
    revalidate.mockClear();
    const again = await sm.regenerateSitemap({ reason: 'test' });
    expect(again.hash).toBe(first.hash);
    expect(await count()).toBe(n);
    expect(revalidate).not.toHaveBeenCalled();
    await sm.regenerateSitemap({ force: true, reason: 'test' });
    expect(await count()).toBe(n + 1);
    expect(revalidate).toHaveBeenCalledWith(['sitemap'], expect.anything());
    const status = await sm.getSitemapStatus();
    expect(status.hash).toBe(first.hash);
    expect(status.urlCount).toBeGreaterThanOrEqual(6); // 4 static + this post + its category
  });

  it('publish-scheduled publishes a due post exactly once, even with two concurrent runs', async () => {
    await post('due', { status: 'scheduled', publishAt: ago(0.01) });
    revalidate.mockClear();
    await Promise.all([jobs.publishScheduled(now), jobs.publishScheduled(now)]);
    expect(await statusOf('due')).toBe('published');
    expect(await statusOf('sched-future')).toBe('scheduled');
    const [id] = await dbm.db.execute<{ id: string }>(sql`select id from blog_posts where slug = ${slug('due')}`);
    const audits = await dbm.db.execute<{ actor_type: string }>(sql`select actor_type from admin_audit_log where action = 'blog.auto_publish' and target_id = ${id!.id}`);
    expect(audits.map((a) => a.actor_type)).toEqual(['system']);
    const tags = revalidate.mock.calls.flatMap((c) => c[0]);
    expect(tags).toEqual(expect.arrayContaining(['blog', 'landing', 'feed', `blog:post:${slug('due')}`, `blog:category:${slug('cat')}`, 'sitemap']));
    expect((await sm.buildBlogSitemap(dbm.db)).map((e) => e.path)).toContain(`/blog/${slug('due')}`);
    expect(await jobs.publishScheduled(now)).toEqual({ published: 0 }); // idempotent
  });

  it('cleanup purges posts deleted 30+ days ago and their orphan assets', async () => {
    const [orphan, kept] = [uuid(), uuid()];
    await dbm.db.execute(sql`insert into blog_assets (id, key, width, height, mime, size, created_at) values
      (${orphan}, ${`blog/t3-${run}/o.webp`}, 1, 1, 'image/webp', 1, ${ago(40)}::timestamptz),
      (${kept}, ${`blog/t3-${run}/k.webp`}, 1, 1, 'image/webp', 1, ${ago(40)}::timestamptz)`);
    await post('old-deleted', { deleted: ago(31), cover: orphan });
    await post('recent-deleted', { deleted: ago(29), cover: kept });
    await jobs.cleanupBlog(now);
    expect(await statusOf('old-deleted')).toBeUndefined();
    expect(await statusOf('recent-deleted')).toBe('published');
    const left = await dbm.db.execute<{ id: string }>(sql`select id from blog_assets where id in (${orphan}, ${kept})`);
    expect(left.map((r) => r.id)).toEqual([kept]);
    expect(deletePrefix).toHaveBeenCalledWith(`blog/${orphan}/`, expect.any(String));
    expect(deletePrefix).not.toHaveBeenCalledWith(`blog/${kept}/`, expect.anything());
  });
});
