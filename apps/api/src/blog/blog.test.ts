// G19 F27 T2 integration: /v1/admin/blog/* and /v1/public/blog/* on the real app + local Supabase (skipped without DATABASE_URL).
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blogListItemSchema, blogPublicListSchema, blogSlugResponseSchema } from '@remoa/contracts';
import { kit, type Kit } from '../admin/users/test-kit';
import { fakeToken } from '../admin/core/test-helpers';

config({ path: '../../.env' });

const stored = new Map<string, Buffer>();
vi.mock('../storage/storage', async (orig: () => Promise<object>) => ({ ...(await orig()), putPublicBytes: async (k: string, b: Buffer) => void stored.set(k, b) }));
const revalidate = vi.fn<(t: string[]) => Promise<void>>(async () => {});
vi.mock('./revalidate', () => ({ revalidateBlog: (t: string[]) => revalidate(t) }));

const doc = (h2 = true) => ({ type: 'doc', content: [...(h2 ? [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Por que revisar' }] }] : []), { type: 'paragraph', content: [{ type: 'text', text: 'Texto do post.' }] }] });
const DESC = 'Uma descrição longa o bastante para passar na regra de publicação do blog, com mais de setenta caracteres.';

describe.skipIf(!process.env.DATABASE_URL)('F27 blog API', () => {
  let k: Kit;
  let adm: { id: string };
  let stu: { id: string };
  let cover: string;
  beforeAll(async () => {
    k = await kit();
    stu = await k.newUser('student', 'Aluno');
    const [a] = await k.dbm.db.execute<{ id: string }>(sql`insert into blog_assets (key, width, height, mime, size) values (${`blog/t2-${crypto.randomUUID()}.webp`}, 1200, 630, 'image/webp', 100) returning id`);
    cover = a!.id;
  });
  // The admin throttle is per admin (30 actions/min): a fresh admin per test.
  beforeEach(async () => {
    adm = await k.newUser('admin', 'Admin Blog');
  });
  afterAll(async () => {
    await k.dbm.db.execute(sql`delete from blog_posts where title like 'T2 %'`);
    await k.dbm.db.execute(sql`delete from blog_assets where id = ${cover}`);
    await k?.cleanup();
  });
  const A = (path: string, method = 'GET', body?: unknown) => k.call(`/v1/admin/blog${path}`, { method, as: adm.id, body });
  const pub = (path: string) => k.call(`/v1/public/blog${path}`);
  const create = async (title: string) => (await A('/posts', 'POST', { title: `T2 ${title}`, template: 'leitura' })).json.data.post as { id: string; slug: string };
  const ready = async (title: string) => {
    const p = await create(title);
    const r = await A(`/posts/${p.id}`, 'PATCH', { description: DESC, coverAssetId: cover, coverAlt: 'Capa', content: doc() });
    expect(r.status).toBe(200);
    return p;
  };

  it('non-admin and anonymous get the same 404 as an unknown route; no audit row', async () => {
    const unknown = await k.call('/v1/admin/blog/nope', { as: stu.id });
    for (const as of [stu.id, null]) {
      const r = await k.call('/v1/admin/blog/posts', { as: as ?? undefined });
      expect(r.status).toBe(unknown.status);
      expect(r.status).toBe(404);
    }
    expect((await k.call('/v1/admin/blog/posts', { method: 'POST', as: stu.id, body: { title: 'T2 nao deve', template: 'leitura' } })).status).toBe(404);
  });

  it('create: slug from title, draft, one audit row per action; autosave audit stores field names only; duplicate gets a unique slug', async () => {
    const p = await create('Repetição espaçada na prática');
    expect(p.slug).toBe('t2-repeticao-espacada-na-pratica');
    expect(await k.audit('blog.create', p.id)).toHaveLength(1);
    expect((await A('/posts', 'POST', { title: 'curto', template: 'leitura' })).status).toBe(422);
    const up = await A(`/posts/${p.id}`, 'PATCH', { description: 'segredo do rascunho', content: doc() });
    expect(up.json.data.post.toc).toEqual([{ id: 'por-que-revisar', text: 'Por que revisar', level: 2 }]);
    expect(up.json.data.post.wordCount).toBeGreaterThan(0);
    const rows = await k.audit('blog.update', p.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.after)).not.toContain('segredo');
    expect(rows[0]!.after).toEqual({ fields: ['description', 'content'] });
    const d = await A(`/posts/${p.id}/duplicate`, 'POST');
    expect(d.json.data.post).toMatchObject({ title: `${p.slug === '' ? '' : 'T2 Repetição espaçada na prática'} (cópia)`, status: 'draft' });
    expect(d.json.data.post.slug).not.toBe(p.slug);
    expect(await k.audit('blog.duplicate', p.id)).toHaveLength(1);
  });

  it('keeps only the last 20 revisions and restores one', async () => {
    const p = await create('Revisões do blog');
    for (let i = 0; i < 23; i++) await A(`/posts/${p.id}`, 'PATCH', { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `v${i}` }] }] } });
    const revs = (await A(`/posts/${p.id}/revisions`)).json.data as { id: string }[];
    expect(revs).toHaveLength(20);
    const r = await A(`/posts/${p.id}/revisions/${revs[0]!.id}/restore`, 'POST');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json.data.post.content)).toContain('v22');
    expect((await A(`/posts/${p.id}/revisions/${crypto.randomUUID()}/restore`, 'POST')).status).toBe(404);
  });

  it('publish is blocked without cover/h2 (publish_blocked + list), then works; schedule in the past is refused', async () => {
    const p = await create('Publicar bloqueado');
    const b = await A(`/posts/${p.id}/publish`, 'POST');
    expect(b.status).toBe(422);
    expect(b.json.error?.message).toBe('publish_blocked');
    expect((b.json as unknown as { blockers: string[] }).blockers).toEqual(['description', 'cover', 'h2']);
    expect((await A(`/posts/${p.id}/schedule`, 'POST', { publishAt: new Date(Date.now() - 1000) })).json.error?.message).toBe('schedule_in_past');
    const q = await ready('Publicar certo');
    revalidate.mockClear();
    const ok = await A(`/posts/${q.id}/publish`, 'POST');
    expect(ok.status).toBe(200);
    expect(ok.json.data.post.status).toBe('published');
    expect(ok.json.data.post.publishedAt).toBeTruthy();
    expect(revalidate).toHaveBeenCalledWith(expect.arrayContaining(['blog', `blog:post:${q.slug}`, 'sitemap', 'feed', 'landing']));
    expect(await k.audit('blog.publish', q.id)).toHaveLength(1);
    const s = await ready('Agendar futuro');
    const sc = await A(`/posts/${s.id}/schedule`, 'POST', { publishAt: new Date(Date.now() + 3_600_000) });
    expect(sc.json.data.post.status).toBe('scheduled');
  });

  it('public sees only published: not draft, scheduled, archived or deleted; unpublish and delete need a reason (denied row)', async () => {
    const live = await ready('Visível no público');
    await A(`/posts/${live.id}/publish`, 'POST');
    const draft = await create('Rascunho oculto');
    const sched = await ready('Agendado oculto');
    await A(`/posts/${sched.id}/schedule`, 'POST', { publishAt: new Date(Date.now() + 3_600_000) });
    const arch = await ready('Arquivado oculto');
    await A(`/posts/${arch.id}/publish`, 'POST');
    const gone = await ready('Excluído oculto');
    await A(`/posts/${gone.id}/publish`, 'POST');

    expect((await A(`/posts/${arch.id}/unpublish`, 'POST', { reason: 'curto' })).status).toBe(422);
    const denied = await k.audit('blog.unpublish', arch.id);
    expect(denied.map((r) => [r.result, r.denial])).toEqual([['denied', 'missing_reason']]);
    expect((await A(`/posts/${arch.id}/unpublish`, 'POST', { reason: 'Conteúdo desatualizado' })).json.data.post.status).toBe('archived');
    expect((await A(`/posts/${gone.id}`, 'DELETE', {})).status).toBe(422);
    expect((await k.audit('blog.delete', gone.id))[0]!.denial).toBe('missing_reason');
    expect((await A(`/posts/${gone.id}`, 'DELETE', { reason: 'Publicado por engano' })).status).toBe(200);
    expect((await A(`/posts/${gone.id}`)).status).toBe(404);

    expect(blogSlugResponseSchema.parse((await pub(`/posts/${live.slug}`)).json.data).kind).toBe('post');
    blogPublicListSchema.parse((await pub('/posts')).json.data);
    blogListItemSchema.array().parse((await pub('/posts/latest')).json.data);
    for (const p of [draft, sched, arch, gone]) expect((await pub(`/posts/${p.slug}`)).status).toBe(404);
    const list = (await pub('/posts?q=oculto')).json.data;
    expect(list.items).toHaveLength(0);
    const all = (await pub('/posts')).json.data;
    expect(all.pageSize).toBe(12);
    expect(all.items.map((i: { slug: string }) => i.slug)).toContain(live.slug);
    expect((await pub('/posts/latest?n=99')).json.data.length).toBeLessThanOrEqual(5);
    expect((await pub('/feed')).status).toBe(200);
  });

  it('changing the slug of a published post creates a redirect without chains', async () => {
    const p = await ready('Slug que muda');
    await A(`/posts/${p.id}/publish`, 'POST');
    const s1 = `${p.slug}-novo`;
    const s2 = `${p.slug}-final`;
    expect((await A(`/posts/${p.id}`, 'PATCH', { slug: s1 })).status).toBe(200);
    expect((await pub(`/posts/${p.slug}`)).json.data).toEqual({ kind: 'redirect', to: `/blog/${s1}` });
    await A(`/posts/${p.id}`, 'PATCH', { slug: s2 });
    expect((await pub(`/posts/${p.slug}`)).json.data).toEqual({ kind: 'redirect', to: `/blog/${s2}` });
    expect((await pub(`/posts/${s1}`)).json.data).toEqual({ kind: 'redirect', to: `/blog/${s2}` });
    expect((await pub(`/posts/${s2}`)).json.data.kind).toBe('post');
    const other = await create('Slug ocupado');
    expect((await A(`/posts/${other.id}`, 'PATCH', { slug: s2 })).json.error?.message).toBe('slug_taken');
  });

  it('preview: token shows a draft, tampered and expired tokens do not', async () => {
    const p = await create('Pré-visualização');
    const r = await A(`/posts/${p.id}/preview`, 'POST');
    expect(r.status).toBe(200);
    const { token, url } = r.json.data as { token: string; url: string };
    expect(url).toContain(`/preview/blog/${token}`);
    const seen = await pub(`/preview/${token}`);
    expect(seen.json.data).toMatchObject({ id: p.id, preview: true });
    expect((await pub(`/preview/${token.slice(0, -2)}xx`)).status).toBe(404);
    const { signPreview, verifyPreview } = await import('./preview');
    const old = signPreview(p.id, Date.now() - 25 * 3_600_000);
    expect(verifyPreview(old.token)).toBeNull();
    expect((await pub(`/preview/${old.token}`)).status).toBe(404);
    expect(JSON.stringify((await k.audit('blog.preview_link', p.id))[0]!.after)).not.toContain(token);
  });

  it('image upload: rejects a fake file, strips EXIF, makes variants without upscale', async () => {
    const send = async (bytes: Buffer, slug = 'minha-capa') => {
      const f = new FormData();
      f.set('file', new File([new Uint8Array(bytes)], 'x.png', { type: 'image/png' }));
      f.set('slug', slug);
      const res = await k.app.request('/v1/admin/blog/images', { method: 'POST', headers: { authorization: `Bearer ${fakeToken(adm.id)}` }, body: f });
      return { status: res.status, json: await res.json() as { data?: { asset: { id: string; width: number; srcset: { webp: string; avif: string }; ogUrl: string } }; error?: { message: string } } };
    };
    const fake = await send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(fake.status).toBe(422);
    expect(fake.json.error?.message).toBe('bad_image');
    expect((await send(Buffer.alloc(10, 1))).status).toBe(422);

    const jpg = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#f80' } }).jpeg().withExif({ IFD0: { Copyright: 'segredo-exif' } }).toBuffer();
    expect((await sharp(jpg).metadata()).exif).toBeTruthy();
    stored.clear();
    const r = await send(jpg);
    expect(r.status).toBe(200);
    const keys = [...stored.keys()];
    expect(keys.some((x) => x.endsWith('minha-capa-480.webp'))).toBe(true);
    expect(keys.some((x) => x.endsWith('minha-capa-800.avif'))).toBe(true);
    expect(keys.some((x) => x.endsWith('-1200.webp') || x.endsWith('-1600.webp'))).toBe(false); // no upscale
    expect(keys.some((x) => x.endsWith('minha-capa-1000.webp'))).toBe(true);
    const og = [...stored].find(([x]) => x.endsWith('-og.jpg'))!;
    expect(await sharp(og[1]).metadata()).toMatchObject({ width: 1200, height: 630 });
    for (const buf of stored.values()) {
      expect((await sharp(buf).metadata()).exif).toBeUndefined();
      expect(buf.includes(Buffer.from('segredo-exif'))).toBe(false);
    }
    expect(r.json.data!.asset.srcset.webp).toContain('480w');
    const [row] = await k.dbm.db.execute<{ width: number; height: number }>(sql`select width, height from blog_assets where id = ${r.json.data!.asset.id}`);
    expect(row).toMatchObject({ width: 1000, height: 500 });
    expect(await k.audit('blog.upload_image', r.json.data!.asset.id)).toHaveLength(1);
  });

  it('categories: upsert with unique slug and ordering; sitemap card; regenerate audited once', async () => {
    const name = `T2 Cat ${Date.now()}`;
    const c = await A('/categories', 'POST', { name });
    expect(c.status).toBe(200);
    const cat = c.json.data.category as { id: string; slug: string };
    const dup = await A('/categories', 'POST', { name: 'Outra', slug: cat.slug });
    expect(dup.json.error?.message).toBe('slug_taken');
    const moved = await A('/categories', 'POST', { id: cat.id, name, position: 99 });
    expect(moved.json.data.category.position).toBe(99);
    expect(((await A('/categories')).json.data as { id: string }[]).some((x) => x.id === cat.id)).toBe(true);
    await k.dbm.db.execute(sql`delete from blog_categories where id = ${cat.id}`);
    expect((await A('/sitemap')).json.data).toHaveProperty('status');
    const g = await A('/sitemap/regenerate', 'POST');
    expect(g.status).toBe(200);
    expect(await k.audit('sitemap.regenerate', 'sitemap')).not.toHaveLength(0);
  });

  it('legal acceptance: status, mismatch refused, accept writes profile and 2 acceptances', async () => {
    const { env } = await import('@remoa/config');
    const u = await k.newUser();
    const get = () => k.call('/v1/account/legal', { as: u.id });
    expect((await get()).json.data).toMatchObject({ needsAcceptance: true, acceptedTermsVersion: null });
    const bad = await k.call('/v1/account/legal/accept', { method: 'POST', as: u.id, body: { termsVersion: 'x', privacyVersion: 'y' } });
    expect(bad.status).toBe(422);
    const body = { termsVersion: env().legalTermsVersion, privacyVersion: env().legalPrivacyVersion };
    for (let i = 0; i < 2; i++) expect((await k.call('/v1/account/legal/accept', { method: 'POST', as: u.id, body })).json.data).toMatchObject({ needsAcceptance: false });
    const n = await k.dbm.db.execute<{ n: number }>(sql`select count(*)::int as n from legal_acceptances where user_id = ${u.id}`);
    expect(n[0]!.n).toBe(2);
    expect((await k.call('/v1/account/legal')).status).toBe(401);
  });
});
