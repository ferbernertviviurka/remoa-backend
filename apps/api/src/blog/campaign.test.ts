import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import expected from './campaign-2026-10.json';
import fixture from './campaign-2026-10.fixture.json';

const fake = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), invalidate: vi.fn(), sitemap: vi.fn() }));
vi.mock('../db', async (original) => ({ ...(await original<typeof import('../db')>()), dbm: async () => ({ db: { transaction: fake.transaction } }) }));
vi.mock('../cache', () => ({ invalidate: fake.invalidate }));
vi.mock('./sitemap', () => ({ regenerateSitemap: fake.sitemap }));
vi.mock('../inngest/notices', () => ({ isNoticeJob: () => false, noticeJobs: {} }));
import { campaignAuthorization, campaignCandidateMatches, campaignContentHash, campaignEnrollment, publishCampaign, type CampaignCandidate } from './campaign';
import { cronRoutes } from '../routes/cron';

// Self-contained source fixture; runtime imports only the 20 metadata/hash pins, never these articles.
const manifest = { posts: fixture };
const enrollment = expected.map((p) => ({ slug: p.slug, id: randomUUID(), coverAssetId: randomUUID() }));
const vars = { BLOG_CAMPAIGN_2026_10_SECRET: 'campaign-secret-'.repeat(3), BLOG_CAMPAIGN_2026_10_ENROLLMENT: JSON.stringify(enrollment), CRON_SECRET: 'broad-secret' };
const now = new Date('2026-10-10T12:00:00Z');
function candidate(index = 0): CampaignCandidate {
  const p = expected[index]!;
  const member = enrollment[index]!;
  return { id: member.id, slug: p.slug, status: 'scheduled', publish_at: p.publishAt, published_at: null, deleted_at: null,
    title: p.title, seo_title: p.seoTitle, description: p.description, excerpt: p.excerpt, template: p.template,
    cover_alt: p.coverAlt, focus_keyword: p.focusKeyword, robots: 'index', canonical_url: null,
    cover_asset_id: member.coverAssetId, category_slug: p.categorySlug, author_id: null,
    content_json: manifest.posts.find((e) => e.slug === p.slug)!.content };
}
beforeEach(() => { vi.stubEnv('SITE_URL', 'https://remoa.com.br'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('campaign identity and fail-closed scope', () => {
  it('pins all20 actual final manifest hashes and metadata, with distinct daily times', () => {
    expect(manifest.posts).toHaveLength(20);
    expect(new Set(expected.map((p) => p.publishAt)).size).toBe(20);
    for (const p of expected) {
      const source = manifest.posts.find((e) => e.slug === p.slug)!;
      expect(campaignContentHash(source.content)).toBe(p.contentSha256);
      for (const key of ['title', 'seoTitle', 'description', 'excerpt', 'template', 'coverAlt', 'focusKeyword', 'categorySlug', 'publishAt'] as const) expect(p[key]).toBe(source[key]);
    }
  });
  it('canonicalizes key order/editor defaults but preserves meaningful text, links and FAQ', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text', marks: [{ type: 'link', attrs: { href: 'https://example.com', external: true } }] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] }] };
    const editor = JSON.parse(JSON.stringify(doc));
    editor.content[0].content[0].marks[0].attrs = { rel: null, href: 'https://example.com' };
    editor.content[1].attrs = { start: 1 };
    editor.content.push({ type: 'paragraph' });
    expect(campaignContentHash(editor)).toBe(campaignContentHash(doc));
    const internalBlank = JSON.parse(JSON.stringify(editor));
    internalBlank.content.splice(1, 0, { type: 'paragraph' });
    expect(campaignContentHash(internalBlank)).not.toBe(campaignContentHash(doc));
    editor.content[0].content[0].marks[0].attrs.rel = 'nofollow';
    expect(campaignContentHash(editor)).not.toBe(campaignContentHash(doc));
    editor.content[0].content[0].marks[0].attrs.rel = null;
    editor.content[0].content[0].text = 'Another';
    expect(campaignContentHash(editor)).not.toBe(campaignContentHash(doc));
    editor.content[0].content[0].text = 'Text';
    editor.content[1].attrs.start = 2;
    expect(campaignContentHash(editor)).not.toBe(campaignContentHash(doc));
  });
  it('accepts native clipboard absolute production anchors for all20 documents, with default HTTPS port only', () => {
    const absoluteLinks = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(absoluteLinks);
      if (!value || typeof value !== 'object') return value;
      const node = value as Record<string, unknown>;
      const copy = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, absoluteLinks(v)]));
      if (node.type === 'link') {
        const attrs = copy.attrs as Record<string, unknown>;
        if (typeof attrs.href === 'string' && attrs.href.startsWith('/')) attrs.href = `https://remoa.com.br:443${attrs.href}`;
      }
      return copy;
    };
    for (const [i, source] of manifest.posts.entries()) {
      const changed = absoluteLinks(source.content);
      expect(campaignContentHash(changed)).toBe(campaignContentHash(source.content));
      expect(campaignCandidateMatches({ ...candidate(i), content_json: changed }, enrollment, new Date('2026-10-29T05:59Z'))).toBe(true);
    }
  });
  it('preserves different link origin/protocol/port/path/query/hash and non-link attributes', () => {
    const doc = (href: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Create account', marks: [{ type: 'link', attrs: { href } }] }] }] });
    const expectedHash = campaignContentHash(doc('/cadastro?source=blog#signup'));
    expect(campaignContentHash(doc('https://remoa.com.br/cadastro?source=blog#signup'))).toBe(expectedHash);
    for (const href of ['https://other.example/cadastro?source=blog#signup', 'http://remoa.com.br/cadastro?source=blog#signup',
      'https://remoa.com.br:444/cadastro?source=blog#signup', 'https://remoa.com.br/other?source=blog#signup',
      'https://remoa.com.br/cadastro?source=other#signup', 'https://remoa.com.br/cadastro?source=blog#other',
      'https://user:password@remoa.com.br/cadastro?source=blog#signup']) expect(campaignContentHash(doc(href))).not.toBe(expectedHash);
    expect(() => campaignContentHash(doc('file:///cadastro?source=blog#signup'))).toThrow();
    const button = (href: string) => ({ type: 'doc', content: [{ type: 'button', attrs: { text: 'Create account', href } }] });
    expect(campaignContentHash(button('https://remoa.com.br/cadastro'))).not.toBe(campaignContentHash(button('/cadastro')));
  });
  it('takes the HTTPS canonical origin from SITE_URL, with no built-in domain or insecure/nondefault-port fallback', () => {
    const doc = (href: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Study', marks: [{ type: 'link', attrs: { href } }] }] }] });
    vi.stubEnv('SITE_URL', 'https://study.example:443');
    expect(campaignContentHash(doc('https://study.example/study?from=blog#plan'))).toBe(campaignContentHash(doc('/study?from=blog#plan')));
    expect(campaignContentHash(doc('https://remoa.com.br/study?from=blog#plan'))).not.toBe(campaignContentHash(doc('/study?from=blog#plan')));
    vi.stubEnv('SITE_URL', 'http://study.example');
    expect(campaignContentHash(doc('https://study.example/study'))).not.toBe(campaignContentHash(doc('/study')));
    vi.stubEnv('SITE_URL', 'https://study.example:444');
    expect(campaignContentHash(doc('https://study.example:444/study'))).not.toBe(campaignContentHash(doc('/study')));
    vi.stubEnv('SITE_URL', 'https://username:password@study.example');
    expect(campaignContentHash(doc('https://study.example/study'))).not.toBe(campaignContentHash(doc('/study')));
  });
  it('requires complete, unique, exact enrollment; never accepts arbitrary IDs/slugs/config extras', () => {
    expect(campaignEnrollment(vars.BLOG_CAMPAIGN_2026_10_ENROLLMENT)).toEqual(enrollment);
    for (const bad of [undefined, '', '{}', JSON.stringify(enrollment.slice(1)), JSON.stringify([...enrollment, enrollment[0]]),
      JSON.stringify(enrollment.map((p, i) => i ? p : { ...p, slug: 'another-campaign' })),
      JSON.stringify(enrollment.map((p) => ({ ...p, id: enrollment[0]!.id }))),
      JSON.stringify(enrollment.map((p) => ({ ...p, coverAssetId: enrollment[0]!.coverAssetId }))),
      JSON.stringify(enrollment.map((p) => ({ ...p, extra: 'no' })))]) expect(campaignEnrollment(bad)).toBeNull();
  });
  it('dedicated secret is exact, sufficiently long, and cannot equal/fall back to the broad cron secret', () => {
    expect(campaignAuthorization(`Bearer ${vars.BLOG_CAMPAIGN_2026_10_SECRET}`, vars)).toBe('authorized');
    for (const header of [undefined, `Bearer ${vars.CRON_SECRET}`, `bearer ${vars.BLOG_CAMPAIGN_2026_10_SECRET}`, `${vars.BLOG_CAMPAIGN_2026_10_SECRET}`]) expect(campaignAuthorization(header, vars)).toBe('unauthorized');
    for (const overrides of [{ BLOG_CAMPAIGN_2026_10_SECRET: undefined }, { BLOG_CAMPAIGN_2026_10_SECRET: 'short' },
      { CRON_SECRET: vars.BLOG_CAMPAIGN_2026_10_SECRET }, { BLOG_CAMPAIGN_2026_10_ENROLLMENT: undefined }]) expect(campaignAuthorization(undefined, { ...vars, ...overrides })).toBe('disabled');
  });
  it('rejects wrong identity/status/time/content/metadata; allows only due scheduled enrolled posts', () => {
    expect(campaignCandidateMatches(candidate(), enrollment, now)).toBe(true);
    expect(campaignCandidateMatches({ ...candidate(), excerpt: null }, enrollment, now)).toBe(true);
    for (const patch of [{ status: 'draft' }, { status: 'published' }, { status: 'archived' }, { deleted_at: now }, { id: randomUUID() },
      { slug: 'unrelated' }, { cover_asset_id: randomUUID() }, { publish_at: null }, { publish_at: new Date('2026-10-09T12:01Z') },
      { title: 'Changed' }, { seo_title: null }, { description: 'Changed' }, { excerpt: 'Unexpected excerpt' }, { template: 'leitura' }, { cover_alt: 'Changed' },
      { focus_keyword: null }, { category_slug: 'another' }, { robots: 'noindex' }, { canonical_url: 'https://example.com' },
      { author_id: randomUUID() }, { content_json: { type: 'doc', content: [] } }, { content_json: { type: 'unsupported' } }]) {
      expect(campaignCandidateMatches({ ...candidate(), ...patch }, enrollment, now), JSON.stringify(patch)).toBe(false);
    }
    expect(campaignCandidateMatches(candidate(2), enrollment, now)).toBe(false);
    expect(campaignCandidateMatches(candidate(), enrollment, new Date('2026-10-09T11:59:59Z'))).toBe(false);
    expect(campaignCandidateMatches(candidate(), enrollment, new Date('2026-10-29T06:00:00Z'))).toBe(false);
    expect(campaignCandidateMatches(candidate(), enrollment, new Date('invalid'))).toBe(false);
  });
});

describe('campaign transaction and route', () => {
  it('locks exact IDs, rechecks scope, audits updates, commits before effects and is idempotent', async () => {
    const row = candidate();
    const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
    let committed = false;
    fake.transaction.mockImplementation(async (fn) => { const result = await fn({ execute: fake.execute }); committed = true; return result; });
    fake.execute.mockImplementation(async (q: SQL) => {
      const compiled = new PgDialect().sqlToQuery(q); queries.push(compiled);
      if (compiled.sql.includes('select p.id')) return [row, { ...candidate(), id: randomUUID() }];
      if (compiled.sql.includes('update blog_posts')) { row.status = 'published'; row.published_at = row.publish_at; return [{ id: row.id }]; }
      return [];
    });
    fake.invalidate.mockImplementation(async () => { expect(committed).toBe(true); });
    expect(await publishCampaign(now, enrollment)).toEqual({ published: 1 });
    expect(queries[0]!.sql).toContain('for update of p');
    expect(queries[0]!.params[0]).toBe(`{${enrollment.map((e) => `"${e.id}"`).join(',')}}`);
    expect(queries.filter((q) => q.sql.includes('update blog_posts'))).toHaveLength(1);
    expect(queries.find((q) => q.sql.includes('insert into admin_audit_log'))!.sql).toContain("'system'");
    expect(fake.invalidate).toHaveBeenCalledWith('blog.changed', { slugs: [row.slug], categorySlugs: [row.category_slug] }, expect.anything());
    expect(fake.sitemap).toHaveBeenCalledTimes(1);
    expect(await publishCampaign(now, enrollment)).toEqual({ published: 0 });
    expect(fake.sitemap).toHaveBeenCalledTimes(2);
    expect(queries.filter((q) => q.sql.includes('update blog_posts'))).toHaveLength(1);
    expect(queries.filter((q) => q.sql.includes('insert into admin_audit_log'))).toHaveLength(1);
    // Recover an interrupted cache notification after commit, preserving single publication/audit.
    fake.invalidate.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(publishCampaign(now, enrollment)).rejects.toThrow('cache unavailable');
    expect(await publishCampaign(now, enrollment)).toEqual({ published: 0 });
    expect(queries.filter((q) => q.sql.includes('update blog_posts'))).toHaveLength(1);
    expect(queries.filter((q) => q.sql.includes('insert into admin_audit_log'))).toHaveLength(1);
    expect(fake.sitemap).toHaveBeenCalledTimes(3);
    fake.sitemap.mockRejectedValueOnce(new Error('sitemap unavailable'));
    await expect(publishCampaign(now, enrollment)).rejects.toThrow('sitemap unavailable');
    expect(await publishCampaign(now, enrollment)).toEqual({ published: 0 });
    expect(queries.filter((q) => q.sql.includes('update blog_posts'))).toHaveLength(1);
    expect(queries.filter((q) => q.sql.includes('insert into admin_audit_log'))).toHaveLength(1);
    expect(fake.sitemap).toHaveBeenCalledTimes(5);
  });
  it('expired publisher never reaches the database', async () => {
    expect(await publishCampaign(new Date('2026-10-29T06:00Z'), enrollment)).toEqual({ published: 0 });
    expect(fake.transaction).not.toHaveBeenCalled();
  });
  it('dedicated route rejects missing config, broad secret, request overrides and expiry before writes', async () => {
    const app = new Hono().route('/v1/cron', cronRoutes);
    const request = (suffix = '', header = `Bearer ${vars.BLOG_CAMPAIGN_2026_10_SECRET}`, body?: string) => app.request(`/v1/cron/blog.campaign-2026-10${suffix}`, { method: 'POST', headers: { authorization: header }, body });
    vi.stubEnv('BLOG_CAMPAIGN_2026_10_SECRET', '');
    expect((await request()).status).toBe(503);
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    expect((await request('', `Bearer ${vars.CRON_SECRET}`)).status).toBe(401);
    expect((await request('?now=2026-10-28')).status).toBe(400);
    expect((await request('', undefined, '{}')).status).toBe(400);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T06:00Z'));
    expect((await request()).status).toBe(410);
    expect(fake.transaction).not.toHaveBeenCalled();
    vi.setSystemTime(now);
    fake.transaction.mockResolvedValue({ effects: [], published: 0 });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { campaignId: 'F27-editorial-20d', published: 0 } });
  });
});
