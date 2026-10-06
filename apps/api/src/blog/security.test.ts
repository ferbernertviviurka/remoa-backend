// G19 F27 T11 (qa): adversarial checks on the blog API: stored HTML only from the renderer, preview token scope, no draft leak,
// upload size cut while streaming. Real app + local Supabase (skipped without DATABASE_URL).
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { kit, type Kit } from '../admin/users/test-kit';
import { fakeToken } from '../admin/core/test-helpers';

config({ path: '../../.env' });

vi.mock('../storage/storage', async (orig: () => Promise<object>) => ({ ...(await orig()), putPublicBytes: async () => undefined }));
vi.mock('./revalidate', () => ({ blogChanged: async () => undefined }));
vi.mock('../cache', async (orig) => ({ ...(await orig<typeof import('../cache')>()), invalidate: async () => ({ tags: [], dropped: 0 }) }));

const XSS = '<img src=x onerror=alert(1)></script><script>alert(2)</script>';
const evilDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: XSS }] },
    { type: 'paragraph', content: [{ type: 'text', text: '"onmouseover="alert(3)', marks: [{ type: 'bold' }] }] },
    { type: 'faq', attrs: { items: [{ q: `${XSS}?`, a: '</script><script>alert(4)</script>' }] } },
  ],
};

describe.skipIf(!process.env.DATABASE_URL)('F27 blog security (T11)', () => {
  let k: Kit;
  let adm: { id: string };
  beforeAll(async () => {
    k = await kit();
  });
  beforeEach(async () => {
    adm = await k.newUser('admin', 'Admin Seg');
  });
  afterAll(async () => {
    await k.dbm.db.execute(sql`delete from blog_posts where title like 'T11 %'`);
    await k?.cleanup();
  });
  const A = (path: string, method = 'GET', body?: unknown) => k.call(`/v1/admin/blog${path}`, { method, as: adm.id, body });
  const pub = (path: string) => k.call(`/v1/public/blog${path}`);
  const create = async (title: string) => (await A('/posts', 'POST', { title: `T11 ${title}`, template: 'leitura' })).json.data.post as { id: string; slug: string };
  const htmlOf = async (id: string) => (await k.dbm.db.execute<{ html: string }>(sql`select content_html as html from blog_posts where id = ${id}`))[0]!.html;

  it('content_html comes only from the renderer: client html is ignored, text is escaped, no raw tag or handler survives', async () => {
    const p = await create('Sanitização');
    const r = await A(`/posts/${p.id}`, 'PATCH', { content: evilDoc, contentHtml: '<script>alert(0)</script>', html: '<script>alert(0)</script>' });
    expect(r.status).toBe(200);
    const html = await htmlOf(p.id);
    expect(html).not.toMatch(/<script|<img|<\/script|<[^>]*\son\w+=/i); // `<` only opens real tags: none carries a handler
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;onmouseover=&quot;');
    // unsafe hrefs never pass the schema
    for (const href of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example', 'vbscript:x']) {
      const bad = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }] }] };
      expect((await A(`/posts/${p.id}`, 'PATCH', { content: bad })).status, href).toBe(422);
    }
  });

  it('restoring a tampered revision re-renders it (javascript: href becomes plain text)', async () => {
    const p = await create('Revisão adulterada');
    const tampered = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'clique', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] };
    const [rev] = await k.dbm.db.execute<{ id: string }>(sql`insert into blog_revisions (post_id, title, content_json) values (${p.id}, 'x', ${JSON.stringify(tampered)}::jsonb) returning id`);
    expect((await A(`/posts/${p.id}/revisions/${rev!.id}/restore`, 'POST')).status).toBe(200);
    const html = await htmlOf(p.id);
    expect(html).toBe('<p>clique</p>');
  });

  it('preview token is bound to its post, never cached, and a draft never leaks through public routes', async () => {
    const a = await create('Prévia A rascunho');
    const b = await create('Prévia B rascunho');
    const { token } = (await A(`/posts/${a.id}/preview`, 'POST')).json.data as { token: string };
    const [, mac] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ p: b.id, e: Date.now() + 3_600_000 })).toString('base64url')}.${mac}`;
    const r = await k.app.request(`/v1/public/blog/preview/${forged}`);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const ok = await k.app.request(`/v1/public/blog/preview/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('no-store');

    const dump = JSON.stringify([
      (await pub('/posts')).json, (await pub('/posts/latest')).json, (await pub('/feed')).json, (await pub('/sitemap')).json, (await pub(`/posts?q=${encodeURIComponent('Prévia')}`)).json,
    ]);
    for (const p of [a, b]) {
      expect(dump).not.toContain(p.id);
      expect(dump).not.toContain(p.slug);
      expect((await pub(`/posts/${p.slug}`)).status).toBe(404);
    }
  });

  it('image upload over the limit is refused even without content-length (streamed body)', async () => {
    const total = 32 * 1024 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (pulled >= total) return ctl.close();
        pulled += 64 * 1024;
        ctl.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const res = await k.app.request('/v1/admin/blog/images', {
      method: 'POST',
      headers: { authorization: `Bearer ${fakeToken(adm.id)}`, 'content-type': 'multipart/form-data; boundary=x' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('bad_image');
    expect(pulled).toBeLessThan(8 * 1024 * 1024); // cut while streaming, not after buffering all 32 MB
  });
});
