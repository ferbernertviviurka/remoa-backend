// F27 T1 (FR-24, D-919): schema.org JSON-LD builders. Pure: the domain comes in as `siteUrl` (SITE_URL / NEXT_PUBLIC_SITE_URL),
// names and logos by parameter, nothing hardcoded. No personal data beyond the public author name (F25 "Regras de negócio").
import type { BlogFaqItem } from '@remoa/contracts';

type Obj = Record<string, unknown>;
const CTX = 'https://schema.org';

/** Absolute URL: http(s) values pass through, paths are joined to siteUrl ("/" -> siteUrl + "/"). */
export const absoluteUrl = (siteUrl: string, path: string): string =>
  /^https?:\/\//i.test(path) ? path : `${siteUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export type Org = { name: string; logoUrl: string; sameAs?: string[] };
const orgNode = (siteUrl: string, org: Org): Obj => ({
  '@type': 'Organization',
  name: org.name,
  url: absoluteUrl(siteUrl, '/'),
  logo: { '@type': 'ImageObject', url: absoluteUrl(siteUrl, org.logoUrl) },
  ...(org.sameAs?.length ? { sameAs: org.sameAs } : {}),
});

export type BlogPostingInput = {
  siteUrl: string;
  /** "/blog/<slug>" */
  path: string;
  title: string;
  description: string;
  image?: { url: string; width: number; height: number } | null;
  datePublished: string;
  dateModified: string;
  /** null = the publisher is the author ("Equipe Remoa"). */
  authorName: string | null;
  publisher: Org;
  section?: string | null;
  wordCount?: number;
};

export function blogPostingJsonLd(p: BlogPostingInput): Obj {
  const url = absoluteUrl(p.siteUrl, p.path);
  const publisher = orgNode(p.siteUrl, p.publisher);
  return {
    '@context': CTX,
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.description,
    ...(p.image ? { image: { '@type': 'ImageObject', url: absoluteUrl(p.siteUrl, p.image.url), width: p.image.width, height: p.image.height } } : {}),
    datePublished: p.datePublished,
    dateModified: p.dateModified,
    author: p.authorName ? { '@type': 'Person', name: p.authorName } : publisher,
    publisher,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    url,
    inLanguage: 'pt-BR',
    ...(p.section ? { articleSection: p.section } : {}),
    ...(p.wordCount ? { wordCount: p.wordCount } : {}),
  };
}

/** Items in order, e.g. [{ name: 'Início', path: '/' }, { name: 'Blog', path: '/blog' }, { name: title, path: '/blog/x' }]. */
export const breadcrumbJsonLd = (siteUrl: string, items: { name: string; path: string }[]): Obj => ({
  '@context': CTX,
  '@type': 'BreadcrumbList',
  itemListElement: items.map((i, n) => ({ '@type': 'ListItem', position: n + 1, name: i.name, item: absoluteUrl(siteUrl, i.path) })),
});

/** null when there is no FAQ (FAQPage only "quando houver bloco de FAQ"). */
export const faqPageJsonLd = (items: BlogFaqItem[]): Obj | null =>
  items.length
    ? {
        '@context': CTX,
        '@type': 'FAQPage',
        mainEntity: items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
      }
    : null;

export const organizationJsonLd = (siteUrl: string, org: Org): Obj => ({ '@context': CTX, ...orgNode(siteUrl, org) });

export const websiteJsonLd = (siteUrl: string, name: string): Obj => ({
  '@context': CTX,
  '@type': 'WebSite',
  name,
  url: absoluteUrl(siteUrl, '/'),
  inLanguage: 'pt-BR',
});

/** JSON for <script type="application/ld+json">: escapes < > & and U+2028/2029 so text can't close the script tag. */
export const jsonLdScript = (obj: unknown): string =>
  JSON.stringify(obj).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
