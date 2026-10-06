// G19 / F27 blog fixtures for the web until /v1/admin/blog and /v1/public/blog land (CCR-040). Example content only.
import {
  blogCategorySchema, blogListItemSchema, blogPostSchema, extractToc, readingMinutes, countWords, sitemapStatusSchema,
  type BlogCategory, type BlogDoc, type BlogListItem, type BlogPost, type SitemapStatus,
} from '../blog';
import { FIXTURE_NOW, MOCK_APP_URL, fid } from './fixtures';

/** Same 4 categories as the seed (migration 0029), intros still drafts. */
export const blogCategoryFixtures: BlogCategory[] = [
  ['estrategia-de-estudo', 'Estratégia de estudo'],
  ['tecnicas-de-memorizacao', 'Técnicas de memorização'],
  ['enamed-e-residencia', 'Enamed e residência'],
  ['produtividade', 'Produtividade'],
].map(([slug, name], i) => blogCategorySchema.parse({ id: fid(9101 + i), slug, name, intro: '', introDraft: true, position: i, postCount: i === 1 ? 1 : 0 }));

const content: BlogDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'A repetição espaçada distribui as revisões no tempo para você lembrar mais estudando menos.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Como funciona' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Veja o ' }, { type: 'text', text: 'guia de revisão', marks: [{ type: 'link', attrs: { href: '/blog/guia-de-revisao' } }] }] },
    { type: 'callout', attrs: { variant: 'dica' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revise no dia em que o card vence.' }] }] },
    { type: 'faq', attrs: { items: [{ q: 'Quantas revisões por dia?', a: 'As que vencerem hoje.' }] } },
  ],
};
const words = countWords(content);
const cover = {
  id: fid(9201), url: `${MOCK_APP_URL}/blog-assets/repeticao-1200.webp`, width: 1600, height: 900, mime: 'image/webp', size: 120_000,
  srcset: { webp: `${MOCK_APP_URL}/blog-assets/repeticao-800.webp 800w`, avif: `${MOCK_APP_URL}/blog-assets/repeticao-800.avif 800w` },
  ogUrl: `${MOCK_APP_URL}/blog-assets/repeticao-og.jpg`,
};

export const blogPostFixture: BlogPost = blogPostSchema.parse({
  id: fid(9301), slug: 'repeticao-espacada-na-residencia', title: 'Repetição espaçada na residência', seoTitle: null,
  description: 'Como usar a repetição espaçada para lembrar mais na prova de residência sem aumentar as horas de estudo.',
  excerpt: null, template: 'leitura', status: 'published', category: blogCategoryFixtures[1], author: null, cover, coverAlt: 'Calendário de revisões',
  focusKeyword: 'repetição espaçada', robots: 'index', canonicalUrl: null, content, toc: extractToc(content), wordCount: words,
  readingMinutes: readingMinutes(words), publishAt: null, publishedAt: FIXTURE_NOW, contentUpdatedAt: FIXTURE_NOW, createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW, deletedAt: null,
});

const toItem = (p: BlogPost): BlogListItem => blogListItemSchema.parse({
  ...p, category: p.category && { id: p.category.id, slug: p.category.slug, name: p.category.name },
  cover: p.cover && { url: p.cover.url, width: p.cover.width, height: p.cover.height, srcset: p.cover.srcset, alt: p.coverAlt },
});
export const blogListItemFixtures: BlogListItem[] = [
  toItem(blogPostFixture),
  toItem({ ...blogPostFixture, id: fid(9302), slug: 'rascunho-de-exemplo', title: 'Rascunho de exemplo do blog', status: 'draft', publishedAt: null, cover: null }),
];

export const sitemapStatusFixture: SitemapStatus = sitemapStatusSchema.parse({
  urlCount: 8, lastGeneratedAt: new Date('2026-10-01T06:00:00Z'), nextRunAt: new Date('2026-10-02T06:00:00Z'), hash: null,
});
