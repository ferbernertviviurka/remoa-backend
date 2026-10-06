import { describe, expect, it } from 'vitest';
import { blogDocSchema, extractToc, type BlogBlock, type BlogDoc } from '@remoa/contracts';
import {
  absoluteUrl,
  blogPostingJsonLd,
  breadcrumbJsonLd,
  escapeHtml,
  faqPageJsonLd,
  firstParagraphText,
  jsonLdScript,
  organizationJsonLd,
  postReadingMinutes,
  postWordCount,
  renderPostHtml,
  renderPostSummary,
  websiteJsonLd,
  type RenderOptions,
} from './index';

const opts: RenderOptions = {
  image: (ref) =>
    ref.assetId === 'missing'
      ? null
      : ref.assetId
        ? { src: `https://cdn.test/blog/${ref.assetId}/x-1200.webp`, srcset: 'https://cdn.test/a-480.webp 480w, https://cdn.test/a-800.webp 800w', sizes: '(max-width: 720px) 100vw, 720px', width: 1200, height: 800 }
        : { src: ref.src!, width: 640, height: 480 },
};
// Untrusted input: bypass the TS type on purpose.
const doc = (...content: unknown[]) => ({ type: 'doc', content }) as unknown as BlogDoc;
const html = (...content: unknown[]) => renderPostHtml(doc(...content), opts);
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const txt = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const link = (href: string, rel?: string) => ({ type: 'link', attrs: { href, ...(rel ? { rel } : {}) } });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [txt(text)] });

/** No executable surface: every real tag (text `<` is always escaped) is allow-listed and carries only allow-listed attributes. */
const TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'blockquote', 'div', 'figure', 'img', 'figcaption', 'details', 'summary']);
const ATTRS = new Set(['id', 'href', 'target', 'rel', 'class', 'role', 'data-variant', 'src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'start']);
const assertInert = (out: string) => {
  for (const [, name, attrs] of out.matchAll(/<([a-z0-9]+)([^>]*)>/gi)) {
    expect(TAGS).toContain(name);
    for (const [, attr, value] of attrs!.matchAll(/\s([^\s=]+)="([^"]*)"/g)) {
      expect(ATTRS).toContain(attr);
      expect(value).not.toMatch(/^\s*(javascript|data|vbscript):/i);
    }
    expect(attrs!.replace(/\s[^\s=]+="[^"]*"/g, '')).toBe('');
  }
};

describe('escapeHtml', () => {
  it('escapes the 5 html characters', () => expect(escapeHtml(`<a href="x" b='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; b=&#39;y&#39;&gt;&amp;&lt;/a&gt;'));
});

describe('renderPostHtml: blocks', () => {
  it('paragraph with bold, italic and internal link', () => {
    expect(html(p(txt('a '), txt('b', [{ type: 'bold' }]), txt('c', [{ type: 'italic' }, { type: 'bold' }]), txt('d', [link('/blog/x')]))))
      .toBe('<p>a <strong>b</strong><strong><em>c</em></strong><a href="/blog/x">d</a></p>');
  });
  it('empty paragraph and empty text', () => expect(html(p(), { type: 'paragraph' }, p(txt('')))).toBe('<p></p><p></p><p></p>'));
  it('external links open in a new tab with noopener noreferrer and optional nofollow/sponsored', () => {
    expect(html(p(txt('x', [link('https://a.test/p?q=1&r=2')])))).toBe('<p><a href="https://a.test/p?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">x</a></p>');
    expect(html(p(txt('x', [link('http://a.test', 'nofollow')])))).toContain('rel="noopener noreferrer nofollow"');
    expect(html(p(txt('x', [link('https://a.test', 'sponsored')])))).toContain('rel="noopener noreferrer sponsored"');
    expect(html(p(txt('x', [link('https://a.test', 'ugc onclick')])))).toContain('rel="noopener noreferrer"');
  });
  it('anchors and mailto have no target', () => {
    expect(html(p(txt('x', [link('#secao')])))).toBe('<p><a href="#secao">x</a></p>');
    expect(html(p(txt('x', [link('mailto:a@b.test')])))).toBe('<p><a href="mailto:a@b.test">x</a></p>');
  });
  it('lists, nested lists and ordered start', () => {
    const li = (...c: unknown[]) => ({ type: 'listItem', content: c });
    expect(html({ type: 'bulletList', content: [li(p(txt('a')), { type: 'orderedList', attrs: { start: 3 }, content: [li(p(txt('b')))] })] }))
      .toBe('<ul><li><p>a</p><ol start="3"><li><p>b</p></li></ol></li></ul>');
    expect(html({ type: 'orderedList', attrs: { start: 1 }, content: [li(p(txt('a')))] })).toBe('<ol><li><p>a</p></li></ol>');
    expect(html({ type: 'orderedList', attrs: { start: '2" onclick="x' }, content: [li(p(txt('a')))] })).toBe('<ol><li><p>a</p></li></ol>');
    expect(html({ type: 'bulletList', content: [{ type: 'paragraph' }] })).toBe('');
  });
  it('blockquote', () => expect(html({ type: 'blockquote', content: [p(txt('q'))] })).toBe('<blockquote><p>q</p></blockquote>'));
  it('callout = div.rb-callout role=note with the variant label (D-931)', () => {
    expect(html({ type: 'callout', attrs: { variant: 'atencao' }, content: [p(txt('cuidado')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(txt('i'))] }] }] }))
      .toBe('<div class="rb-callout" role="note" data-variant="atencao"><div><p><strong>Atenção.</strong> cuidado</p><ul><li><p>i</p></li></ul></div></div>');
    expect(html({ type: 'callout', attrs: { variant: 'dica' }, content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(txt('i'))] }] }] }))
      .toBe('<div class="rb-callout" role="note" data-variant="dica"><div><p><strong>Dica.</strong></p><ul><li><p>i</p></li></ul></div></div>');
    expect(html({ type: 'callout', attrs: { variant: '"><script>' }, content: [p(txt('x'))] })).toContain('data-variant="nota"><div><p><strong>Nota.</strong> x');
  });
  it('image: figure with alt, dimensions, lazy, srcset and caption', () => {
    expect(html({ type: 'image', attrs: { assetId: 'a1', alt: 'Curva "de" <esquecimento>', caption: 'Fonte & ano', width: 1, height: 1 } })).toBe(
      '<figure><img src="https://cdn.test/blog/a1/x-1200.webp" srcset="https://cdn.test/a-480.webp 480w, https://cdn.test/a-800.webp 800w" sizes="(max-width: 720px) 100vw, 720px"'
        + ' alt="Curva &quot;de&quot; &lt;esquecimento&gt;" width="1200" height="800" loading="lazy" decoding="async"><figcaption>Fonte &amp; ano</figcaption></figure>',
    );
    expect(html({ type: 'image', attrs: { src: 'https://img.test/a.png', alt: 'x', width: 1, height: 1 } }))
      .toBe('<figure><img src="https://img.test/a.png" alt="x" width="640" height="480" loading="lazy" decoding="async"></figure>');
  });
  it('image without alt, without source or unresolved is omitted', () => {
    expect(html({ type: 'image', attrs: { assetId: 'a1', alt: '  ', width: 1, height: 1 } })).toBe('');
    expect(html({ type: 'image', attrs: { alt: 'x', width: 1, height: 1 } })).toBe('');
    expect(html({ type: 'image' })).toBe('');
    expect(renderPostHtml(doc({ type: 'image', attrs: { src: 'http://img.test/a.png', alt: 'x', width: 1, height: 1 } }), { image: (r) => (r.src ? { src: r.src, width: 1, height: 1 } : null) })).toBe(''); // P-433: external src is https only
    expect(html({ type: 'image', attrs: { assetId: 'missing', alt: 'x', width: 1, height: 1 } })).toBe('');
    const bad = (r: object) => renderPostHtml(doc({ type: 'image', attrs: { assetId: 'a', alt: 'x' } }), { image: () => ({ src: 'https://c.test/a', width: 1, height: 1, ...r }) });
    expect(bad({ width: 0 })).toBe('');
    expect(bad({ height: 1.5 })).toBe('');
    expect(bad({ src: 'javascript:alert(1)' })).toBe('');
    expect(bad({ src: 'data:image/png;base64,AAAA' })).toBe('');
    expect(bad({ src: 'mailto:a@b.test' })).toBe('');
    expect(bad({ src: '/blog/a.webp' })).toContain('src="/blog/a.webp"');
  });
  it('button with safe href; unsafe or empty is dropped', () => {
    expect(html({ type: 'button', attrs: { text: 'Criar conta', href: '/cadastro' } })).toBe('<a class="rb-button" href="/cadastro">Criar conta</a>');
    expect(html({ type: 'button', attrs: { text: 'Ir', href: 'https://x.test' } })).toBe('<a class="rb-button" href="https://x.test" target="_blank" rel="noopener noreferrer">Ir</a>');
    expect(html({ type: 'button', attrs: { text: 'Ir', href: 'javascript:alert(1)' } })).toBe('');
    expect(html({ type: 'button', attrs: { text: ' ', href: '/x' } })).toBe('');
  });
  it('FAQ as details/summary (D-931), answer lines become paragraphs', () => {
    expect(html({ type: 'faq', attrs: { items: [{ q: 'O que é <FSRS>?', a: 'Um agendador.\n\nCom memória.' }, { q: '', a: 'x' }] } })).toBe(
      '<div class="rb-faq"><details class="rb-faq-item"><summary>O que é &lt;FSRS&gt;?</summary><p>Um agendador.</p><p>Com memória.</p></details></div>',
    );
    expect(html({ type: 'faq', attrs: { items: [] } })).toBe('');
    expect(html({ type: 'faq' })).toBe('');
  });
});

describe('renderPostHtml: headings', () => {
  it('ids are exactly the extractToc ids, h4 gets a unique id', () => {
    const d = doc(h(2, 'Introdução'), h(3, 'Introdução'), h(4, 'Introdução'), h(2, ''), h(2, 'Introdução'), h(4, 'Outro'));
    const ids = [...renderPostHtml(d, opts).matchAll(/<h([234]) id="([^"]+)">/g)].map((m) => [Number(m[1]), m[2]]);
    const toc = extractToc(d);
    expect(ids.filter(([l]) => l !== 4).map(([, id]) => id)).toEqual(toc.map((t) => t.id));
    expect(ids).toEqual([[2, 'introducao'], [3, 'introducao-2'], [4, 'introducao-4'], [2, 'secao'], [2, 'introducao-3'], [4, 'outro']]);
  });
  it('heading with marks', () => expect(html({ type: 'heading', attrs: { level: 2 }, content: [txt('A', [{ type: 'bold' }])] })).toBe('<h2 id="a"><strong>A</strong></h2>'));
  it('level 1, 5 and missing level are rejected (single H1 is the title)', () => {
    expect(html(h(1, 'Título'), h(5, 'x'), { type: 'heading', content: [txt('y')] }, { type: 'heading', attrs: { level: 2 }, content: 'str' })).toBe('');
    expect(html(h(1, 'Intro'), h(2, 'Intro'))).toBe('<h2 id="intro">Intro</h2>');
  });
  it('id attribute is escaped', () => expect(html(h(2, '"><img src=x onerror=alert(1)>'))).toBe('<h2 id="img-src-x-onerror-alert-1">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</h2>'));
});

describe('renderPostHtml: adversarial input', () => {
  const vectors = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'javascript&#58;alert(1)',
    'javascript&colon;alert(1)',
    '&#106;avascript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'DATA:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.test/x',
    '/\\evil.test',
    'https://x.test/" onclick="alert(1)',
    '',
  ];
  it.each(vectors)('link %j becomes plain text', (href) => {
    const out = html(p(txt('clique', [link(href)])));
    expect(out).toBe('<p>clique</p>');
  });
  it('quotes in a safe href cannot break out of the attribute', () => {
    const out = html(p(txt('x', [link("/a'b")])));
    expect(out).toBe('<p><a href="/a&#39;b">x</a></p>');
  });
  it('script/iframe/style as text are escaped', () => {
    const out = html(p(txt('<script>alert(1)</script><iframe src=x></iframe><style>*{}</style><img src=x onerror=alert(1)>')));
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    assertInert(out);
  });
  it('unknown nodes, marks and attributes are ignored', () => {
    const out = html(
      { type: 'html', text: '<script>alert(1)</script>' },
      { type: 'iframe', attrs: { src: 'https://evil.test' } },
      { type: 'script', content: [txt('alert(1)')] },
      { type: 'paragraph', attrs: { onclick: 'alert(1)', style: 'x', class: 'y' }, content: [txt('ok', [{ type: 'code' }, { type: 'style', attrs: { css: 'x' } }]), { type: 'image', attrs: { src: 'x' } }, null, 'str'] },
      null,
      'texto solto',
      { type: 'text', text: 'top-level text' },
      { type: 'button', attrs: { text: 'b', href: '/x', onclick: 'alert(1)' } },
    );
    expect(out).toBe('<p>ok</p><a class="rb-button" href="/x">b</a>');
  });
  it('non-array content and garbage documents do not throw', () => {
    expect(html({ type: 'blockquote', content: 'x' }, { type: 'bulletList', content: [{ type: 'listItem', content: { type: 'paragraph' } }] })).toBe('<blockquote></blockquote><ul><li></li></ul>');
    expect(renderPostHtml({} as BlogDoc, opts)).toBe('');
    expect(renderPostHtml({ type: 'doc', content: 'x' } as unknown as BlogDoc, opts)).toBe('');
  });
  it('a full hostile document renders inert', () => {
    const out = html(
      h(2, '<script>x</script>'),
      p(txt('"onmouseover="alert(1)', [link('JaVaScRiPt:alert(1)'), { type: 'bold' }])),
      { type: 'image', attrs: { src: 'https://x.test/a.png', alt: '" onerror="alert(1)', caption: '<svg onload=alert(1)>', width: 1, height: 1 } },
      { type: 'callout', attrs: { variant: 'dica', onclick: 'x' }, content: [p(txt('<iframe>'))] },
      { type: 'faq', attrs: { items: [{ q: '<script>', a: '<img src=x onerror=alert(1)>' }] } },
    );
    assertInert(out);
    expect(out).toContain('alt="&quot; onerror=&quot;alert(1)"');
  });
});

describe('a validated document round-trips', () => {
  const valid: BlogBlock[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'Primeiro parágrafo   com  espaço.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Como funciona' }] },
    { type: 'faq', attrs: { items: [{ q: 'Pergunta?', a: 'Resposta.' }] } },
  ];
  const d = blogDocSchema.parse({ type: 'doc', content: valid });
  it('summary aggregates html, toc, faq, words and minutes', () => {
    const s = renderPostSummary(d, opts);
    expect(s.html).toContain('<h2 id="como-funciona">');
    expect(s.toc).toEqual([{ id: 'como-funciona', text: 'Como funciona', level: 2 }]);
    expect(s.faq).toEqual([{ q: 'Pergunta?', a: 'Resposta.' }]);
    expect(s.wordCount).toBe(postWordCount(d));
    expect(s.wordCount).toBe(8);
    expect(s.readingMinutes).toBe(1);
    expect(postReadingMinutes(d)).toBe(1);
  });
  it('reading minutes = words / 220 rounded up', () => {
    const long = blogDocSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: Array(441).fill('palavra').join(' ') }] }] });
    expect(postReadingMinutes(long)).toBe(3);
  });
  it('firstParagraphText skips empty and non-paragraph blocks', () => {
    expect(firstParagraphText(d)).toBe('Primeiro parágrafo com espaço.');
    expect(firstParagraphText(doc(h(2, 'x'), p(), p(txt('  ')), p(txt('a'), txt('b'))))).toBe('ab');
    expect(firstParagraphText(doc())).toBe('');
  });
});

describe('JSON-LD', () => {
  const site = 'https://site.test/';
  const publisher = { name: 'Org', logoUrl: '/logo.png' };
  it('absoluteUrl', () => {
    expect(absoluteUrl(site, '/blog/x')).toBe('https://site.test/blog/x');
    expect(absoluteUrl('https://site.test', '/')).toBe('https://site.test/');
    expect(absoluteUrl(site, 'https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
  });
  it('BlogPosting with person author, image and section', () => {
    const ld = blogPostingJsonLd({ siteUrl: site, path: '/blog/x', title: 'T', description: 'D', image: { url: 'https://cdn.test/og.jpg', width: 1200, height: 630 },
      datePublished: '2026-10-01T00:00:00Z', dateModified: '2026-10-02T00:00:00Z', authorName: 'Ana', publisher, section: 'Método', wordCount: 900 });
    expect(ld).toMatchObject({
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'T', description: 'D',
      image: { '@type': 'ImageObject', url: 'https://cdn.test/og.jpg', width: 1200, height: 630 },
      author: { '@type': 'Person', name: 'Ana' },
      publisher: { '@type': 'Organization', name: 'Org', url: 'https://site.test/', logo: { url: 'https://site.test/logo.png' } },
      mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://site.test/blog/x' },
      articleSection: 'Método', wordCount: 900,
    });
  });
  it('BlogPosting without author/image: publisher is the author', () => {
    const ld = blogPostingJsonLd({ siteUrl: site, path: '/blog/x', title: 'T', description: 'D', image: null, datePublished: 'a', dateModified: 'b', authorName: null, publisher });
    expect(ld.author).toEqual(ld.publisher);
    expect(ld).not.toHaveProperty('image');
    expect(ld).not.toHaveProperty('articleSection');
  });
  it('BreadcrumbList', () => {
    expect(breadcrumbJsonLd(site, [{ name: 'Início', path: '/' }, { name: 'Blog', path: '/blog' }])).toEqual({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Início', item: 'https://site.test/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://site.test/blog' },
      ],
    });
  });
  it('FAQPage only when there are items', () => {
    expect(faqPageJsonLd([])).toBeNull();
    expect(faqPageJsonLd([{ q: 'Q', a: 'A' }])).toEqual({ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Q', acceptedAnswer: { '@type': 'Answer', text: 'A' } }] });
  });
  it('Organization and WebSite', () => {
    expect(organizationJsonLd(site, { ...publisher, sameAs: ['https://x.test/org'] })).toEqual({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Org',
      url: 'https://site.test/', logo: { '@type': 'ImageObject', url: 'https://site.test/logo.png' }, sameAs: ['https://x.test/org'] });
    expect(websiteJsonLd(site, 'Org')).toEqual({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Org', url: 'https://site.test/', inLanguage: 'pt-BR' });
  });
  it('jsonLdScript cannot close the script tag and still parses back', () => {
    const obj = faqPageJsonLd([{ q: '</script><script>alert(1)</script>', a: 'a & b > c \u2028' }]);
    const s = jsonLdScript(obj);
    expect(s).not.toMatch(/[<>&\u2028\u2029]/);
    expect(s).toContain('\\u003c/script\\u003e');
    expect(JSON.parse(s)).toEqual(obj);
  });
});
