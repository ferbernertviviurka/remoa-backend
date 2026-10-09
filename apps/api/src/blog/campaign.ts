// Temporary, fail-closed publisher for the explicitly enrolled October campaign. No CRUD or broad cron dispatch.
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { blogDocSchema } from '@remoa/contracts';
import { env } from '@remoa/config';
import { createLogger, newRequestId } from '@remoa/log';
import { dbm, uuids } from '../db';
import { invalidate } from '../cache';
import { regenerateSitemap } from './sitemap';
import expected from './campaign-2026-10.json';

export const CAMPAIGN_ID = 'F27-editorial-20d';
export const CAMPAIGN_EXPIRES_AT = Date.parse('2026-10-29T06:00:00Z');
const digest = (s: string) => createHash('sha256').update(s).digest();

/** Match JSONB key ordering and defaults introduced by the real Tiptap round-trip.
 * Only link.external (a rendering hint), null rel and list start=1 are equivalent defaults.
 * Native clipboard resolves relative anchors against the HTML base: only the exact HTTPS production origin
 * is equivalent to its relative path, preserving every path/search/hash character. Other destinations remain distinct.
 * Text, links, marks, FAQ and ordering remain significant. */
function canonicalLinkHref(value: unknown, siteOrigin: string | null): unknown {
  if (typeof value !== 'string' || !value.startsWith('https://')) return value;
  try {
    const url = new URL(value);
    return siteOrigin !== null && url.origin === siteOrigin && !url.username && !url.password ? `${url.pathname}${url.search}${url.hash}` : value;
  } catch { return value; }
}
function normalize(value: unknown, siteOrigin: string | null, linkAttrs = false): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, siteOrigin));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(obj).sort().flatMap((key) => {
    const v = obj[key];
    if ((linkAttrs && key === 'external') || (linkAttrs && key === 'rel' && v == null) || (key === 'start' && v === 1)) return [];
    const next = linkAttrs && key === 'href' ? canonicalLinkHref(v, siteOrigin) : normalize(v, siteOrigin, key === 'attrs' && obj.type === 'link');
    if (key === 'attrs' && next && typeof next === 'object' && !Object.keys(next).length) return [];
    return [[key, next]];
  }));
}

export function campaignContentHash(value: unknown): string {
  const doc = blogDocSchema.parse(value);
  const site = new URL(env().siteUrl);
  const siteOrigin = site.protocol === 'https:' && !site.port && !site.username && !site.password ? site.origin : null;
  // The editor appends an empty top-level paragraph; do not discard nested structure.
  const content = [...doc.content];
  while (content.at(-1)?.type === 'paragraph') {
    const last = content.at(-1)!;
    if (last.type !== 'paragraph' || last.content?.length) break;
    content.pop();
  }
  return createHash('sha256').update(JSON.stringify(normalize({ ...doc,
    content,
  }, siteOrigin))).digest('hex');
}

const enrollmentSchema = z.array(z.object({ slug: z.string(), id: z.string().uuid(), coverAssetId: z.string().uuid() }).strict()).length(20);
export type CampaignEnrollment = z.infer<typeof enrollmentSchema>;

export function campaignEnrollment(raw: string | undefined): CampaignEnrollment | null {
  try {
    const entries = enrollmentSchema.parse(JSON.parse(raw ?? ''));
    if (expected.length !== 20 || new Set(entries.map((e) => e.id)).size !== 20 || new Set(entries.map((e) => e.slug)).size !== 20
      || new Set(entries.map((e) => e.coverAssetId)).size !== 20 || entries.some((e) => !expected.some((p) => p.slug === e.slug))) return null;
    return entries;
  } catch { return null; }
}

export function campaignAuthorization(header: string | undefined, vars: NodeJS.ProcessEnv = process.env): 'authorized' | 'disabled' | 'unauthorized' {
  const secret = vars.BLOG_CAMPAIGN_2026_10_SECRET;
  if (!secret || secret.length < 32 || secret === vars.CRON_SECRET || !campaignEnrollment(vars.BLOG_CAMPAIGN_2026_10_ENROLLMENT)) return 'disabled';
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${secret}`)) ? 'authorized' : 'unauthorized';
}

export type CampaignCandidate = {
  id: string; slug: string; status: string; publish_at: Date | string | null; published_at: Date | string | null; deleted_at: Date | string | null;
  title: string; seo_title: string | null; description: string; excerpt: string | null; template: string;
  cover_alt: string; focus_keyword: string | null; robots: string; canonical_url: string | null;
  cover_asset_id: string | null; category_slug: string | null; author_id: string | null; content_json: unknown;
};

export function campaignCandidateMatches(row: CampaignCandidate, enrollment: CampaignEnrollment, now: Date): boolean {
  const member = enrollment.find((e) => e.id === row.id && e.slug === row.slug);
  const post = expected.find((e) => e.slug === row.slug);
  if (!member || !post || !Number.isFinite(now.getTime()) || now.getTime() >= CAMPAIGN_EXPIRES_AT || row.deleted_at
    || row.status !== 'scheduled' || !row.publish_at || Date.parse(String(row.publish_at)) !== Date.parse(post.publishAt)
    || Date.parse(post.publishAt) > now.getTime() || row.cover_asset_id !== member.coverAssetId || row.author_id !== null) return false;
  // The audited admin editor has no excerpt control: null is its legitimate representation. Any other excerpt still fails.
  if (row.title !== post.title || row.seo_title !== post.seoTitle || row.description !== post.description || (row.excerpt !== null && row.excerpt !== post.excerpt)
    || row.template !== post.template || row.cover_alt !== post.coverAlt || row.focus_keyword !== post.focusKeyword
    || row.category_slug !== post.categorySlug || row.robots !== 'index' || row.canonical_url !== null) return false;
  try { return campaignContentHash(row.content_json) === post.contentSha256; } catch { return false; }
}

export async function publishCampaign(now: Date, enrollment: CampaignEnrollment) {
  if (!Number.isFinite(now.getTime()) || now.getTime() >= CAMPAIGN_EXPIRES_AT) return { published: 0 };
  const { db } = await dbm();
  const result = await db.transaction(async (tx) => {
    // Lock only the exact enrolled IDs. Recheck every field inside the transaction, before any write.
    const candidates = await tx.execute<CampaignCandidate>(sql`
      select p.id, p.slug, p.status, p.publish_at, p.published_at, p.deleted_at, p.title, p.seo_title, p.description, p.excerpt,
        p.template, p.cover_alt, p.focus_keyword, p.robots, p.canonical_url, p.cover_asset_id, p.author_id,
        p.content_json, c.slug as category_slug
      from blog_posts p join blog_categories c on c.id = p.category_id join blog_assets a on a.id = p.cover_asset_id
      where p.id = any(${uuids(enrollment.map((e) => e.id))})
        and (p.status = 'scheduled' or (p.status = 'published' and p.published_at = p.publish_at))
        and p.publish_at <= ${now.toISOString()}::timestamptz and p.deleted_at is null
      order by p.id for update of p`);
    const effects: CampaignCandidate[] = [];
    let published = 0;
    for (const p of candidates) {
      // An exact already-published enrolled post needs only cache/sitemap retry, never an UPDATE or second audit.
      const already = p.status === 'published' && p.published_at !== null && p.publish_at !== null
        && new Date(p.published_at).getTime() === new Date(p.publish_at).getTime();
      if (!campaignCandidateMatches(already ? { ...p, status: 'scheduled' } : p, enrollment, now)) continue;
      if (already) { effects.push(p); continue; }
      const at = new Date(p.publish_at!).toISOString();
      const updated = await tx.execute<{ id: string }>(sql`
        update blog_posts set status = 'published', published_at = publish_at, updated_at = now()
        where id = ${p.id}::uuid and status = 'scheduled' and deleted_at is null
          and publish_at = ${at}::timestamptz returning id`);
      if (!updated.length) continue;
      await tx.execute(sql`insert into admin_audit_log (actor_type, action, target_type, target_id, reason, result, before, after)
        values ('system', 'blog.auto_publish', 'blog_post', ${p.id}, ${CAMPAIGN_ID}, 'success',
          ${JSON.stringify({ status: 'scheduled', publishAt: at, campaignId: CAMPAIGN_ID })}::jsonb,
          ${JSON.stringify({ status: 'published', publishedAt: at, campaignId: CAMPAIGN_ID })}::jsonb)`);
      effects.push(p);
      published++;
    }
    return { effects, published };
  });
  const rows = result.effects;
  if (rows.length) {
    const log = createLogger({ requestId: newRequestId() });
    await invalidate('blog.changed', { slugs: rows.map((p) => p.slug), categorySlugs: rows.flatMap((p) => p.category_slug ? [p.category_slug] : []) }, log);
    await regenerateSitemap({ reason: CAMPAIGN_ID }, now);
    log.info('blog campaign reconciled', { campaignId: CAMPAIGN_ID, published: result.published, revalidated: rows.length });
  }
  return { published: result.published };
}
