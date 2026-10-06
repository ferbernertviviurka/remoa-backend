import { describe, expect, it } from 'vitest';
import {
  blogDocSchema, blogPostInputSchema, countWords, docHrefs, extractFaq, extractToc, isSafeHref, isValidSlug, legalAcceptInputSchema,
  publishBlockers, readingMinutes, seoChecklist, slugify, type BlogDoc, type SeoSubject,
} from './blog';
import { adminActions, auditTargetTypes } from './admin';

const p = (text: string) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] });
const h = (level: 2 | 3 | 4, text: string) => ({ type: 'heading' as const, attrs: { level }, content: [{ type: 'text' as const, text }] });
const link = (text: string, href: string) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text, marks: [{ type: 'link' as const, attrs: { href } }] }] });
const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ');
const doc = (...content: BlogDoc['content']): BlogDoc => ({ type: 'doc', content });

const good: SeoSubject = {
  title: 'Repetição espaçada para a residência médica',
  seoTitle: null,
  description: 'Entenda como a repetição espaçada ajuda a lembrar mais na prova de residência e como montar sua rotina de revisão sem perder tempo.',
  slug: 'repeticao-espacada-residencia',
  coverAssetId: '00000000-0000-4000-8000-000000000001',
  coverAlt: 'Calendário de revisões',
  focusKeyword: 'Repetição espaçada',
  content: doc(
    p(`A repetição espaçada é o método. ${words(600)}`),
    h(2, 'Como funciona'),
    h(3, 'Intervalos'),
    link('veja o guia', '/blog/guia'),
    link('estudo', 'https://example.org/estudo'),
    { type: 'image', attrs: { assetId: '00000000-0000-4000-8000-000000000002', alt: 'Gráfico', width: 800, height: 450 } },
  ),
};

describe('slugify / isValidSlug', () => {
  it('lowercases, strips accents and symbols, trims hyphens', () => {
    expect(slugify('  Repetição Espaçada: o Guia!  ')).toBe('repeticao-espacada-o-guia');
    expect(slugify('---')).toBe('');
  });
  it('caps at 70 without a trailing hyphen', () => {
    const s = slugify(`${'a'.repeat(69)} bcd`);
    expect(s.length).toBeLessThanOrEqual(70);
    expect(s.endsWith('-')).toBe(false);
    expect(isValidSlug(s)).toBe(true);
  });
  it('validates', () => {
    expect(isValidSlug('abc-123')).toBe(true);
    for (const bad of ['', 'Abc', 'a--b', '-a', 'a-', 'á', 'a b', 'a'.repeat(71)]) expect(isValidSlug(bad)).toBe(false);
  });
});

describe('isSafeHref', () => {
  it('allows http, https, mailto, internal paths and anchors', () => {
    for (const ok of ['https://a.com/x', 'http://a.com', 'mailto:contato@remoa.com.br', '/blog/x', '#secao']) expect(isSafeHref(ok)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.com', '/\\evil.com', 'ftp://a.com', '#', '', ' ',
      'https://a.com/\nx', 'mailto:', 'not a url', 'vbscript:x', `https://a.com/${'a'.repeat(2050)}`]) expect(isSafeHref(bad)).toBe(false);
  });
});

describe('blogDocSchema', () => {
  it('accepts every allowed block and strips unknown attributes', () => {
    const raw = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'color:red' }, content: [{ type: 'text', text: 'oi', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: 'https://a.com', rel: 'sponsored', external: true, target: '_blank', onclick: 'x' } }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H2' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('a'), { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p('b')] }] }] }] },
        { type: 'blockquote', content: [p('citação')] },
        { type: 'callout', attrs: { variant: 'atencao' }, content: [p('cuidado')] },
        { type: 'image', attrs: { src: 'https://cdn.example.com/x.webp', alt: 'x', caption: 'legenda', width: 10, height: 10, onerror: 'x' } },
        { type: 'button', attrs: { text: 'Criar mapa', href: '/cadastro' } },
        { type: 'faq', attrs: { items: [{ q: 'P?', a: 'R.' }] } },
      ],
    };
    const r = blogDocSchema.safeParse(raw);
    expect(r.success).toBe(true);
    const s = JSON.stringify(r.success && r.data);
    expect(s).not.toMatch(/style|onclick|onerror|target/);
  });
  it.each([
    ['script node', { type: 'script', content: [] }],
    ['iframe node', { type: 'iframe', attrs: { src: 'https://a.com' } }],
    ['h1', h(1 as 2, 'x')],
    ['h5', h(5 as 2, 'x')],
    ['javascript link', link('x', 'javascript:alert(1)')],
    ['unknown mark', { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' }] }] }],
    ['image without alt', { type: 'image', attrs: { assetId: '00000000-0000-4000-8000-000000000001', alt: '  ', width: 1, height: 1 } }],
    ['image with both sources', { type: 'image', attrs: { assetId: '00000000-0000-4000-8000-000000000001', src: 'https://a.com/x.png', alt: 'x', width: 1, height: 1 } }],
    ['image with http src', { type: 'image', attrs: { src: 'http://a.com/x.png', alt: 'x', width: 1, height: 1 } }],
    ['image with data src', { type: 'image', attrs: { src: 'data:image/png;base64,AA', alt: 'x', width: 1, height: 1 } }],
    ['button to javascript', { type: 'button', attrs: { text: 'x', href: 'javascript:x' } }],
    ['bad callout', { type: 'callout', attrs: { variant: 'perigo' }, content: [p('x')] }],
    ['empty faq', { type: 'faq', attrs: { items: [] } }],
    ['bad rel', link('x', 'https://a.com')],
  ])('rejects %s', (name, block) => {
    const b = name === 'bad rel' ? { ...block, content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://a.com', rel: 'ugc' } }] }] } : block;
    expect(blogDocSchema.safeParse({ type: 'doc', content: [b] }).success).toBe(false);
  });
  it('rejects oversized content', () => {
    const big = Array.from({ length: 30 }, () => p('x'.repeat(19_000)));
    expect(blogDocSchema.safeParse({ type: 'doc', content: big }).success).toBe(false);
  });
});

describe('words, reading time, toc, faq, hrefs', () => {
  it('counts words of text, FAQ and buttons', () => {
    const d = doc(p('um dois'), h(2, 'três'), { type: 'faq', attrs: { items: [{ q: 'quatro', a: 'cinco seis' }] } }, { type: 'button', attrs: { text: 'sete', href: '/x' } });
    expect(countWords(d)).toBe(7);
    expect(countWords('  a — b  ')).toBe(2);
  });
  it('reading minutes = ceil(words / 220), at least 1', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(220)).toBe(1);
    expect(readingMinutes(221)).toBe(2);
  });
  it('extracts H2/H3 with stable, deduplicated ids', () => {
    const d = doc(h(2, 'Introdução'), h(3, 'Introdução'), h(4, 'ignorado'), h(2, '!!!'), p('x'));
    expect(extractToc(d)).toEqual([
      { id: 'introducao', text: 'Introdução', level: 2 },
      { id: 'introducao-2', text: 'Introdução', level: 3 },
      { id: 'secao', text: '!!!', level: 2 },
    ]);
  });
  it('collects FAQ items and hrefs', () => {
    const d = doc({ type: 'faq', attrs: { items: [{ q: 'a', a: 'b' }] } }, link('x', '/a'), { type: 'button', attrs: { text: 'b', href: 'https://b.com' } },
      { type: 'bulletList', content: [{ type: 'listItem', content: [link('y', '/c')] }] });
    expect(extractFaq(d)).toEqual([{ q: 'a', a: 'b' }]);
    expect(docHrefs(d)).toEqual(['/a', 'https://b.com', '/c']);
  });
});

describe('seoChecklist / publishBlockers', () => {
  it('all ok scores 100 and does not block', () => {
    const r = seoChecklist(good);
    expect(r.items.map((i) => [i.id, i.state])).toEqual([
      ['title', 'ok'], ['description', 'ok'], ['slug', 'ok'], ['cover', 'ok'], ['h2', 'ok'],
      ['hierarchy', 'ok'], ['words', 'ok'], ['keyword', 'ok'], ['links', 'ok'], ['images', 'ok'],
    ]);
    expect(r.score).toBe(100);
    expect(r.blocksPublish).toBe(false);
    expect(publishBlockers(good)).toEqual([]);
  });
  it('blocks on the 5 essentials', () => {
    const bad: SeoSubject = { ...good, title: 'curto', description: 'pouco', slug: 'Com Acento', coverAssetId: null, content: doc(p('x')) };
    expect(publishBlockers(bad)).toEqual(['title', 'description', 'slug', 'cover', 'h2']);
    const r = seoChecklist(bad);
    expect(r.blocksPublish).toBe(true);
    expect(r.items.filter((i) => i.blocksPublish).map((i) => i.id)).toEqual(['title', 'description', 'slug', 'cover', 'h2']);
    expect(r.items.find((i) => i.id === 'title')!.state).toBe('error');
    expect(publishBlockers({ ...good, coverAlt: '  ' })).toEqual(['cover']);
  });
  it('warns without blocking', () => {
    const r = seoChecklist({
      ...good,
      seoTitle: 'Título SEO curto demais',
      description: 'Descrição com mais de setenta caracteres mas bem menos do que cento e vinte, o que é aviso.',
      focusKeyword: null,
      content: doc(h(3, 'pulou'), h(2, 'ok'), h(4, 'pulou de novo'), p('poucas palavras'), link('só interno', '/blog/x')),
    });
    const st = Object.fromEntries(r.items.map((i) => [i.id, i.state]));
    expect(st).toMatchObject({ title: 'warn', description: 'warn', hierarchy: 'warn', words: 'warn', keyword: 'warn', links: 'warn', images: 'ok' });
    expect(r.blocksPublish).toBe(false);
    expect(r.score).toBe(4 * 10 + 6 * 5);
  });
  it('keyword must appear in title, description, first paragraph and slug', () => {
    expect(seoChecklist({ ...good, slug: 'outro-endereco' }).items.find((i) => i.id === 'keyword')!.state).toBe('warn');
    expect(seoChecklist({ ...good, content: doc(p('Sem a palavra.'), ...good.content.content.slice(1)) }).items.find((i) => i.id === 'keyword')!.state).toBe('warn');
  });
  it('flags body images without alt (unparsed input)', () => {
    const noAlt = doc(h(2, 'x'), { type: 'image', attrs: { assetId: 'a', alt: '', width: 1, height: 1 } });
    expect(seoChecklist({ ...good, content: noAlt }).items.find((i) => i.id === 'images')!.state).toBe('warn');
  });
});

describe('inputs and audit enums', () => {
  it('patch is partial and validates the slug and canonical', () => {
    expect(blogPostInputSchema.safeParse({}).success).toBe(true);
    expect(blogPostInputSchema.safeParse({ slug: 'Ruim' }).success).toBe(false);
    expect(blogPostInputSchema.safeParse({ canonicalUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('legal versions are short tokens', () => {
    expect(legalAcceptInputSchema.safeParse({ termsVersion: '2026-10-01', privacyVersion: 'v1.2' }).success).toBe(true);
    expect(legalAcceptInputSchema.safeParse({ termsVersion: 'x y', privacyVersion: '1' }).success).toBe(false);
  });
  it('audit enums carry the blog actions', () => {
    expect(adminActions).toEqual(expect.arrayContaining(['blog.publish', 'blog.unpublish', 'sitemap.regenerate', 'blog.auto_publish']));
    expect(auditTargetTypes).toEqual(expect.arrayContaining(['blog_post', 'blog_category', 'sitemap']));
  });
});

describe('F25 telemetry events (CCR-045, CCR-047)', () => {
  it('accepts the documented props and rejects free text or the search term', async () => {
    const { eventSchemas: ev } = await import('./index');
    expect(ev.blog_post_viewed.safeParse({ slug: 'a', template: 'guia', category: 'x' }).success).toBe(true);
    expect(ev.blog_cta_clicked.safeParse({ slug: 'a', position: 'end' }).success).toBe(true);
    expect(ev.blog_search_used.safeParse({ resultCount: 3, queryLength: 5 }).success).toBe(true);
    expect(ev.blog_search_used.safeParse({ resultCount: 3, queryLength: 5, query: 'dm2' }).success).toBe(false);
    expect(ev.landing_blog_clicked.safeParse({ position: 4 }).success).toBe(true);
    expect(ev.landing_blog_clicked.safeParse({ position: 5 }).success).toBe(false);
    expect(ev.legal_page_viewed.safeParse({ document: 'terms' }).success).toBe(true);
    expect(ev.legal_page_viewed.safeParse({ document: 'cookies' }).success).toBe(false);
  });
});
