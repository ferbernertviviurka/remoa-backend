// G19 / F27 Blog Remoa + legal acceptance (feature file docs/features/F25-blog.md). CCR-040, D-908–D-916.
// Routes: admin under /v1/admin/blog (withAdmin), public reads under /v1/public/blog (no auth, published only); full list in the
// feature file "Implementação (D-908)". The post body is a restricted ProseMirror JSON (Tiptap): anything outside these schemas is
// rejected, unknown attributes are stripped, so the API must store the *parse output*, never the raw body (FR-28).
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { reasonSchema } from './admin';

export const blogTemplates = ['leitura', 'guia', 'destaque'] as const;
export type BlogTemplate = (typeof blogTemplates)[number];
export const blogStatuses = ['draft', 'scheduled', 'published', 'archived'] as const;
export type BlogStatus = (typeof blogStatuses)[number];
export const blogRobots = ['index', 'noindex'] as const;
export type BlogRobots = (typeof blogRobots)[number];
export const calloutVariants = ['dica', 'atencao', 'nota'] as const;
export type CalloutVariant = (typeof calloutVariants)[number];
export const linkRels = ['nofollow', 'sponsored'] as const;
export const legalDocuments = ['terms', 'privacy'] as const;
export type LegalDocument = (typeof legalDocuments)[number];

export const BLOG_LIMITS = {
  titleMin: 10,
  titleMax: 140,
  seoTitleMax: 60,
  descriptionPublishMin: 70,
  descriptionMax: 300,
  /** Meta description counter in the editor (FR-5). */
  descriptionCounter: 160,
  excerptMax: 400,
  slugMax: 70,
  altMax: 250,
  captionMax: 300,
  keywordMax: 80,
  textMax: 20_000,
  buttonTextMax: 60,
  hrefMax: 2048,
  faqItemsMax: 20,
  faqTextMax: 2000,
  /** JSON.stringify(content) cap. */
  contentMaxChars: 500_000,
  wordsPerMinute: 220,
  revisions: 20,
  pageSize: 12,
  latest: 5,
  related: 3,
  rssItems: 20,
  previewHours: 24,
  deletedRetentionDays: 30,
  imageMaxBytes: 5 * 1024 * 1024,
  imageWidths: [480, 800, 1200, 1600],
  og: { width: 1200, height: 630 },
  categoryIntroWords: { min: 150, max: 300 },
  categoryNameMax: 60,
} as const;

/** Cron expressions (UTC) of the blog jobs, same registry as inngest/notices.ts (FR-33/34, D-903). */
export const BLOG_JOBS = {
  'sitemap.daily': '0 6 * * *', // 03:00 in São Paulo
  'blog.publish-scheduled': '*/5 * * * *',
  'blog.cleanup': '15 7 * * *',
} as const;
export type BlogJob = keyof typeof BLOG_JOBS;

/** Server-chosen reasons for withAdmin (rule 9) on actions the admin does not justify; unpublish/delete take a typed reason. */
export const BLOG_AUTO_REASONS = {
  create: 'criação de post do blog',
  update: 'edição de post do blog',
  duplicate: 'duplicação de post do blog',
  publish: 'publicação de post do blog',
  schedule: 'agendamento de post do blog',
  restore: 'restauração de revisão do blog',
  upload: 'envio de imagem do blog',
  category: 'edição de categoria do blog',
  preview: 'link de pré-visualização do blog',
  sitemap: 'atualização manual do sitemap',
} as const;

// --- pure helpers --------------------------------------------------------------------------------

const deaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s: string) => deaccent(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** "Repetição Espaçada: o guia!" → "repeticao-espacada-o-guia" (lowercase, no accents, ≤ 70, no edge hyphens). */
export const slugify = (s: string): string =>
  deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, BLOG_LIMITS.slugMax).replace(/-+$/, '');

export const isValidSlug = (s: string): boolean => s.length <= BLOG_LIMITS.slugMax && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

/** Allowed link targets (FR-6): http, https, mailto, internal path ("/x", not "//x") or in-page anchor ("#x"). */
export function isSafeHref(raw: string): boolean {
  const href = raw.trim();
  if (!href || href.length > BLOG_LIMITS.hrefMax || /[\s\u0000-\u001f\u007f\\]/.test(href)) return false;
  if (href.startsWith('#')) return href.length > 1;
  if (href.startsWith('/')) return !href.startsWith('//');
  try {
    const u = new URL(href);
    return u.protocol === 'mailto:' ? u.pathname.includes('@') : (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}
/** Internal = relative path (FR-27); anchors are neither internal nor external. */
export const isInternalHref = (href: string) => href.trim().startsWith('/') && !href.trim().startsWith('//');
export const isExternalHref = (href: string) => /^https?:\/\//i.test(href.trim());

// --- ProseMirror document (FR-6, FR-28) ------------------------------------------------------

export type BlogMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'link'; attrs: { href: string; rel?: (typeof linkRels)[number] | null; external?: boolean } };
export type BlogText = { type: 'text'; text: string; marks?: BlogMark[] };
export type BlogParagraph = { type: 'paragraph'; content?: BlogText[] };
export type BlogHeading = { type: 'heading'; attrs: { level: 2 | 3 | 4 }; content?: BlogText[] };
export type BlogListItemNode = { type: 'listItem'; content: (BlogParagraph | BlogBulletList | BlogOrderedList)[] };
export type BlogBulletList = { type: 'bulletList'; content: BlogListItemNode[] };
export type BlogOrderedList = { type: 'orderedList'; attrs?: { start?: number }; content: BlogListItemNode[] };
export type BlogBlockquote = { type: 'blockquote'; content: (BlogParagraph | BlogBulletList | BlogOrderedList)[] };
export type BlogCallout = { type: 'callout'; attrs: { variant: CalloutVariant }; content: (BlogParagraph | BlogBulletList | BlogOrderedList)[] };
export type BlogImage = {
  type: 'image';
  attrs: { assetId?: string | null; src?: string | null; alt: string; caption?: string | null; width: number; height: number };
};
export type BlogButton = { type: 'button'; attrs: { text: string; href: string } };
export type BlogFaqItem = { q: string; a: string };
export type BlogFaq = { type: 'faq'; attrs: { items: BlogFaqItem[] } };
export type BlogBlock = BlogParagraph | BlogHeading | BlogBulletList | BlogOrderedList | BlogBlockquote | BlogCallout | BlogImage | BlogButton | BlogFaq;
export type BlogDoc = { type: 'doc'; content: BlogBlock[] };

const safeHref = z.string().trim().max(BLOG_LIMITS.hrefMax).refine(isSafeHref, 'unsafe href');
const markSchema: z.ZodType<BlogMark, z.ZodTypeDef, unknown> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }),
  z.object({ type: z.literal('italic') }),
  z.object({
    type: z.literal('link'),
    attrs: z.object({ href: safeHref, rel: z.enum(linkRels).nullable().optional(), external: z.boolean().optional() }),
  }),
]);
const textSchema = z.object({ type: z.literal('text'), text: z.string().min(1).max(BLOG_LIMITS.textMax), marks: z.array(markSchema).max(3).optional() });
const inline = z.array(textSchema).optional();
const paragraphSchema = z.object({ type: z.literal('paragraph'), content: inline });
const headingSchema = z.object({ type: z.literal('heading'), attrs: z.object({ level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }), content: inline });
const listItemSchema: z.ZodType<BlogListItemNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({ type: z.literal('listItem'), content: z.array(z.union([paragraphSchema, bulletListSchema, orderedListSchema])).min(1) }),
);
const bulletListSchema: z.ZodType<BlogBulletList, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({ type: z.literal('bulletList'), content: z.array(listItemSchema).min(1) }),
);
const orderedListSchema: z.ZodType<BlogOrderedList, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({ type: z.literal('orderedList'), attrs: z.object({ start: z.number().int().min(1).max(10_000).optional() }).optional(), content: z.array(listItemSchema).min(1) }),
);
const flow = z.array(z.union([paragraphSchema, bulletListSchema, orderedListSchema])).min(1);
const imageSchema = z.object({
  type: z.literal('image'),
  attrs: z.object({
    assetId: idSchema.nullable().optional(),
    src: z.string().url().max(BLOG_LIMITS.hrefMax).refine(isExternalHref, 'http(s) only').nullable().optional(),
    alt: z.string().trim().min(1).max(BLOG_LIMITS.altMax),
    caption: z.string().trim().max(BLOG_LIMITS.captionMax).nullable().optional(),
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
  }).refine((a) => !!a.assetId !== !!a.src, 'exactly one of assetId | src'),
});
const faqItemSchema = z.object({ q: z.string().trim().min(1).max(BLOG_LIMITS.faqTextMax), a: z.string().trim().min(1).max(BLOG_LIMITS.faqTextMax) });
export const blogBlockSchema: z.ZodType<BlogBlock, z.ZodTypeDef, unknown> = z.union([
  paragraphSchema,
  headingSchema,
  bulletListSchema,
  orderedListSchema,
  z.object({ type: z.literal('blockquote'), content: flow }),
  z.object({ type: z.literal('callout'), attrs: z.object({ variant: z.enum(calloutVariants) }), content: flow }),
  imageSchema,
  z.object({ type: z.literal('button'), attrs: z.object({ text: z.string().trim().min(1).max(BLOG_LIMITS.buttonTextMax), href: safeHref }) }),
  z.object({ type: z.literal('faq'), attrs: z.object({ items: z.array(faqItemSchema).min(1).max(BLOG_LIMITS.faqItemsMax) }) }),
]);
export const blogDocSchema: z.ZodType<BlogDoc, z.ZodTypeDef, unknown> = z
  .object({ type: z.literal('doc'), content: z.array(blogBlockSchema) })
  .refine((d) => JSON.stringify(d).length <= BLOG_LIMITS.contentMaxChars, 'content too large');
export const EMPTY_BLOG_DOC: BlogDoc = { type: 'doc', content: [] };

// --- document helpers ------------------------------------------------------------------------

type AnyNode = { type: string; text?: string; content?: AnyNode[]; attrs?: Record<string, unknown>; marks?: BlogMark[] };
const walk = (nodes: readonly AnyNode[] | undefined, fn: (n: AnyNode) => void) => {
  for (const n of nodes ?? []) {
    fn(n);
    walk(n.content, fn);
  }
};
const inlineText = (n: { content?: readonly AnyNode[] }) => (n.content ?? []).map((c) => c.text ?? '').join('');

/** Readable text of the body (text nodes, FAQ, button labels), blocks separated by spaces. */
export function docText(doc: BlogDoc): string {
  const out: string[] = [];
  walk(doc.content as AnyNode[], (n) => {
    if (n.type === 'text' && n.text) out.push(n.text);
    else if (n.type === 'faq') for (const i of (n.attrs as BlogFaq['attrs']).items) out.push(i.q, i.a);
    else if (n.type === 'button') out.push((n.attrs as BlogButton['attrs']).text);
    if (n.type === 'paragraph' || n.type === 'heading') out.push(' ');
  });
  return out.join(' ');
}

export const countWords = (input: string | BlogDoc): number =>
  (typeof input === 'string' ? input : docText(input)).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** FR-16: words ÷ 220, rounded up, at least 1. */
export const readingMinutes = (words: number): number => Math.max(1, Math.ceil(words / BLOG_LIMITS.wordsPerMinute));

export type BlogTocEntry = { id: string; text: string; level: 2 | 3 };
/** H2/H3 in order with stable ids (slug of the text, "-2", "-3"… on repeats, "secao" when empty). The renderer must use these ids. */
export function extractToc(doc: BlogDoc): BlogTocEntry[] {
  const seen = new Map<string, number>();
  const toc: BlogTocEntry[] = [];
  for (const b of doc.content) {
    if (b.type !== 'heading' || b.attrs.level === 4) continue;
    const text = inlineText(b).trim();
    const base = slugify(text) || 'secao';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    toc.push({ id: n === 1 ? base : `${base}-${n}`, text, level: b.attrs.level });
  }
  return toc;
}

/** FAQ items of every faq block (FAQPage JSON-LD, `blog_posts.faq`). */
export const extractFaq = (doc: BlogDoc): BlogFaqItem[] => doc.content.flatMap((b) => (b.type === 'faq' ? b.attrs.items : []));

/** Every href in the body (link marks and buttons). */
export function docHrefs(doc: BlogDoc): string[] {
  const out: string[] = [];
  walk(doc.content as AnyNode[], (n) => {
    for (const m of n.marks ?? []) if (m.type === 'link') out.push(m.attrs.href);
    if (n.type === 'button') out.push((n.attrs as BlogButton['attrs']).href);
  });
  return out;
}

// --- SEO checklist (FR-8, FR-9) --------------------------------------------------------------

export const seoCheckIds = ['title', 'description', 'slug', 'cover', 'h2', 'hierarchy', 'words', 'keyword', 'links', 'images'] as const;
export type SeoCheckId = (typeof seoCheckIds)[number];
export const seoCheckStates = ['ok', 'warn', 'error'] as const;
export type SeoCheckState = (typeof seoCheckStates)[number];
export const seoCheckSchema = z.object({ id: z.enum(seoCheckIds), state: z.enum(seoCheckStates), blocksPublish: z.boolean() });
export type SeoCheck = z.infer<typeof seoCheckSchema>;
export const seoReportSchema = z.object({ items: z.array(seoCheckSchema), score: z.number().int().min(0).max(100), blocksPublish: z.boolean() });
export type SeoReport = z.infer<typeof seoReportSchema>;
/** Ids of the 5 publish blockers, in checklist order. */
export type PublishBlocker = Extract<SeoCheckId, 'title' | 'description' | 'slug' | 'cover' | 'h2'>;

/** What the checklist reads; BlogPost satisfies it (cover = cover?.id). */
export type SeoSubject = {
  title: string;
  seoTitle?: string | null;
  description: string;
  slug: string;
  coverAssetId?: string | null;
  coverAlt: string;
  focusKeyword?: string | null;
  content: BlogDoc;
};

export function publishBlockers(p: SeoSubject): PublishBlocker[] {
  const out: PublishBlocker[] = [];
  if (p.title.trim().length < BLOG_LIMITS.titleMin) out.push('title');
  if (p.description.trim().length < BLOG_LIMITS.descriptionPublishMin) out.push('description');
  if (!isValidSlug(p.slug)) out.push('slug');
  if (!p.coverAssetId || !p.coverAlt.trim()) out.push('cover');
  if (!p.content.content.some((b) => b.type === 'heading' && b.attrs.level === 2)) out.push('h2');
  return out;
}

/** 10 items of the F25 table; score = ok 10, warn 5, error 0 points each. */
export function seoChecklist(p: SeoSubject): SeoReport {
  const blockers = new Set(publishBlockers(p));
  const range = (len: number, lo: number, hi: number, id: PublishBlocker): SeoCheckState =>
    blockers.has(id) ? 'error' : len >= lo && len <= hi ? 'ok' : 'warn';
  const okOr = (cond: boolean, bad: SeoCheckState): SeoCheckState => (cond ? 'ok' : bad);

  const headings = p.content.content.flatMap((b) => (b.type === 'heading' ? [b.attrs.level] : []));
  const hierarchyOk = headings.every((l, i) => l <= (i === 0 ? 2 : Math.max(2, headings[i - 1]! + 1)));
  const kw = norm(p.focusKeyword ?? '');
  const firstParagraph = p.content.content.find((b): b is BlogParagraph => b.type === 'paragraph' && !!inlineText(b).trim());
  const keywordOk = !!kw && [p.seoTitle || p.title, p.description, firstParagraph ? inlineText(firstParagraph) : ''].every((s) => norm(s).includes(kw))
    && p.slug.includes(slugify(kw));
  const hrefs = docHrefs(p.content);
  const images = p.content.content.filter((b): b is BlogImage => b.type === 'image');

  const states: Record<SeoCheckId, SeoCheckState> = {
    title: range((p.seoTitle || p.title).trim().length, 30, BLOG_LIMITS.seoTitleMax, 'title'),
    description: range(p.description.trim().length, 120, BLOG_LIMITS.descriptionCounter, 'description'),
    slug: okOr(!blockers.has('slug'), 'error'),
    cover: okOr(!blockers.has('cover'), 'error'),
    h2: okOr(!blockers.has('h2'), 'error'),
    hierarchy: okOr(hierarchyOk, 'warn'),
    words: okOr(countWords(p.content) >= 600, 'warn'),
    keyword: okOr(keywordOk, 'warn'),
    links: okOr(hrefs.some(isInternalHref) && hrefs.some(isExternalHref), 'warn'),
    images: okOr(images.every((i) => !!i.attrs.alt?.trim()), 'warn'),
  };
  const items = seoCheckIds.map((id) => ({ id, state: states[id], blocksPublish: blockers.has(id as PublishBlocker) }));
  const score = items.reduce((s, i) => s + (i.state === 'ok' ? 10 : i.state === 'warn' ? 5 : 0), 0);
  return { items, score, blocksPublish: blockers.size > 0 };
}

// --- records ---------------------------------------------------------------------------------

const slugSchema = z.string().trim().max(BLOG_LIMITS.slugMax).refine(isValidSlug, 'invalid slug');
const titleSchema = z.string().trim().min(BLOG_LIMITS.titleMin).max(BLOG_LIMITS.titleMax);
const url = z.string().url().refine(isExternalHref, 'http(s) only');

export const blogAssetVariantSchema = z.object({ key: z.string(), width: z.number().int().positive(), height: z.number().int().positive(), format: z.enum(['webp', 'avif', 'jpeg']) });
export type BlogAssetVariant = z.infer<typeof blogAssetVariantSchema>;
/** Public image (bucket S3_PUBLIC_BUCKET behind R2_PUBLIC_BASE_URL). `srcset` strings are ready for <img>/<source>; ogUrl = 1200×630 JPEG crop. */
export const blogAssetSchema = z.object({
  id: idSchema,
  url: url,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.string(),
  size: z.number().int().positive(),
  srcset: z.object({ webp: z.string(), avif: z.string() }),
  ogUrl: url.nullable(),
});
export type BlogAsset = z.infer<typeof blogAssetSchema>;

export const blogCategoryRefSchema = z.object({ id: idSchema, slug: z.string(), name: z.string() });
export type BlogCategoryRef = z.infer<typeof blogCategoryRefSchema>;
export const blogCategorySchema = blogCategoryRefSchema.extend({
  intro: z.string(),
  /** Seeded placeholder not reviewed yet: the public page hides the intro (D-911). */
  introDraft: z.boolean(),
  position: z.number().int().nonnegative(),
  /** Published + index posts. */
  postCount: z.number().int().nonnegative(),
});
export type BlogCategory = z.infer<typeof blogCategorySchema>;
/** POST /v1/admin/blog/categories (no id = create). */
export const blogCategoryInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(2).max(BLOG_LIMITS.categoryNameMax),
  slug: slugSchema.optional(),
  intro: z.string().trim().max(4000).default(''),
  introDraft: z.boolean().default(false),
  position: z.number().int().nonnegative().optional(),
});
export type BlogCategoryInput = z.input<typeof blogCategoryInputSchema>;

/** null = "Equipe Remoa" (strings). */
export const blogAuthorSchema = z.object({ id: idSchema, name: z.string().nullable() }).nullable();

const coverRef = blogAssetSchema.pick({ url: true, width: true, height: true, srcset: true }).extend({ alt: z.string() }).nullable();

/** Row of the admin list and card of the public grid/Landing. Public reads only ever carry status 'published'. */
export const blogListItemSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  excerpt: z.string().nullable(),
  template: z.enum(blogTemplates),
  status: z.enum(blogStatuses),
  category: blogCategoryRefSchema.nullable(),
  cover: coverRef,
  readingMinutes: z.number().int().min(1),
  publishAt: timestampSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
});
export type BlogListItem = z.infer<typeof blogListItemSchema>;

/** Full post for the admin editor. */
export const blogPostSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: z.string(),
  seoTitle: z.string().nullable(),
  description: z.string(),
  excerpt: z.string().nullable(),
  template: z.enum(blogTemplates),
  status: z.enum(blogStatuses),
  category: blogCategoryRefSchema.nullable(),
  author: blogAuthorSchema,
  cover: blogAssetSchema.nullable(),
  coverAlt: z.string(),
  focusKeyword: z.string().nullable(),
  robots: z.enum(blogRobots),
  canonicalUrl: z.string().nullable(),
  content: blogDocSchema,
  toc: z.array(z.object({ id: z.string(), text: z.string(), level: z.union([z.literal(2), z.literal(3)]) })),
  wordCount: z.number().int().nonnegative(),
  readingMinutes: z.number().int().min(1),
  publishAt: timestampSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  contentUpdatedAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
});
export type BlogPost = z.infer<typeof blogPostSchema>;

/** GET /v1/public/blog/posts/:slug and the preview: what the page renders. `html` is the sanitized cache. */
export const blogPublicPostSchema = blogPostSchema
  .pick({ id: true, slug: true, title: true, seoTitle: true, description: true, excerpt: true, template: true, category: true, author: true,
    cover: true, coverAlt: true, robots: true, canonicalUrl: true, toc: true, wordCount: true, readingMinutes: true, publishedAt: true, contentUpdatedAt: true })
  .extend({
    html: z.string(),
    faq: z.array(faqItemSchema),
    /** "Continue lendo" (same category first). */
    related: z.array(blogListItemSchema),
    /** True only on a preview link: the page adds noindex and the "Pré-visualização" strip. */
    preview: z.boolean(),
  });
export type BlogPublicPost = z.infer<typeof blogPublicPostSchema>;

/** GET /v1/public/blog/posts/:slug: a live post, or the 301 target when the slug changed (FR-12). Unknown/unpublished = 404. */
export const blogSlugResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post'), post: blogPublicPostSchema }),
  z.object({ kind: z.literal('redirect'), to: z.string().startsWith('/blog/') }),
]);
export type BlogSlugResponse = z.infer<typeof blogSlugResponseSchema>;

/** `AppError.message` of blog actions (generic code in parentheses). The editor recomputes the reasons with publishBlockers(). */
export const blogErrors = {
  /** validation — publish/schedule with publishBlockers() not empty */
  publishBlocked: 'publish_blocked',
  /** conflict — slug used by another live post */
  slugTaken: 'slug_taken',
  /** validation — schedule with publishAt <= now */
  scheduleInPast: 'schedule_in_past',
  /** validation — image not PNG/JPEG/WebP by signature, or > 5 MB */
  badImage: 'bad_image',
} as const;

/** POST /v1/admin/blog/posts (FR-4). Slug = slugify(title), "-2"… when taken. */
export const blogPostCreateInputSchema = z.object({ title: titleSchema, template: z.enum(blogTemplates) });
export type BlogPostCreateInput = z.input<typeof blogPostCreateInputSchema>;

/** PATCH /v1/admin/blog/posts/:id (autosave and "Salvar rascunho"): only the fields sent change. Slug change on a published post = 301 (FR-12). */
export const blogPostInputSchema = z.object({
  title: titleSchema,
  seoTitle: z.string().trim().max(BLOG_LIMITS.seoTitleMax).nullable(),
  description: z.string().trim().max(BLOG_LIMITS.descriptionMax),
  excerpt: z.string().trim().max(BLOG_LIMITS.excerptMax).nullable(),
  slug: slugSchema,
  template: z.enum(blogTemplates),
  categoryId: idSchema.nullable(),
  authorId: idSchema.nullable(),
  coverAssetId: idSchema.nullable(),
  coverAlt: z.string().trim().max(BLOG_LIMITS.altMax),
  focusKeyword: z.string().trim().max(BLOG_LIMITS.keywordMax).nullable(),
  robots: z.enum(blogRobots),
  canonicalUrl: url.nullable(),
  content: blogDocSchema,
}).partial();
export type BlogPostInput = z.input<typeof blogPostInputSchema>;

/** POST …/:id/schedule — publishAt must be in the future (checked by the server against its clock). */
export const blogScheduleInputSchema = z.object({ publishAt: timestampSchema });
export type BlogScheduleInput = z.input<typeof blogScheduleInputSchema>;
/** POST …/:id/unpublish and DELETE …/:id (FR-1: typed reason). */
export const blogReasonInputSchema = z.object({ reason: reasonSchema });
export type BlogReasonInput = z.input<typeof blogReasonInputSchema>;
/** POST …/:id/revisions/:revisionId/restore has no body. */
export const blogRevisionSchema = z.object({ id: idSchema, title: z.string(), createdAt: timestampSchema, createdBy: blogAuthorSchema });
export type BlogRevision = z.infer<typeof blogRevisionSchema>;

/** Admin list query (FR-2). `status` 'all' = every non-deleted post. */
export const blogAdminListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['all', ...blogStatuses]).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type BlogAdminListQuery = z.input<typeof blogAdminListQuerySchema>;
export const blogAdminListSchema = z.object({
  items: z.array(blogListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  counts: z.record(z.enum(['all', ...blogStatuses]), z.number().int().nonnegative()),
});
export type BlogAdminList = z.infer<typeof blogAdminListSchema>;

/** Public list query (FR-15/17). */
export const blogPublicListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  category: z.string().trim().max(BLOG_LIMITS.slugMax).optional(),
  q: z.string().trim().max(120).optional(),
});
export type BlogPublicListQuery = z.input<typeof blogPublicListQuerySchema>;
export const blogPublicListSchema = z.object({
  items: z.array(blogListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type BlogPublicList = z.infer<typeof blogPublicListSchema>;

/** Preview (FR-10): signed link valid 24 h; the web opens `${url}` which calls GET /v1/public/blog/preview/:token. */
export const previewLinkSchema = z.object({ url: url, token: z.string(), expiresAt: timestampSchema });
export type PreviewLink = z.infer<typeof previewLinkSchema>;

/** Sitemap (FR-31/32). Built by the API; the web's app/sitemap.ts only renders it. */
export const sitemapEntryKinds = ['home', 'blog', 'category', 'post', 'legal'] as const;
export const sitemapEntrySchema = z.object({ path: z.string().startsWith('/'), kind: z.enum(sitemapEntryKinds), lastmod: timestampSchema });
export type SitemapEntry = z.infer<typeof sitemapEntrySchema>;
/** Public routes the web adds itself (lastmod: newest post for '/' and '/blog', LEGAL_UPDATED_AT for legal pages). D-916. */
export const SITEMAP_STATIC_PATHS = ['/', '/blog', '/termos-de-uso', '/politica-de-privacidade'] as const;
/** Card of the admin list (FR-3). */
export const sitemapStatusSchema = z.object({
  urlCount: z.number().int().nonnegative(),
  lastGeneratedAt: timestampSchema.nullable(),
  nextRunAt: timestampSchema,
  hash: z.string().nullable(),
});
export type SitemapStatus = z.infer<typeof sitemapStatusSchema>;
/** Admin "Ver URLs" (GET /v1/admin/blog/sitemap). urlCount = entries.length + SITEMAP_STATIC_PATHS.length. */
export const adminSitemapSchema = z.object({ status: sitemapStatusSchema, entries: z.array(sitemapEntrySchema) });
export type AdminSitemap = z.infer<typeof adminSitemapSchema>;

/** Body of the web's POST /api/revalidate (Bearer REVALIDATE_SECRET, D-907). Tags: 'blog', `blog:post:<slug>`, `blog:category:<slug>`, 'landing', 'sitemap', 'feed'. */
export const revalidateInputSchema = z.object({ tags: z.array(z.string().min(1).max(200)).min(1).max(50), paths: z.array(z.string().startsWith('/')).max(50).optional() });
export type RevalidateInput = z.infer<typeof revalidateInputSchema>;

// --- legal acceptance (FR-45/46, D-913) --------------------------------------------------------

export const legalVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);
/** Keys the sign-up puts in Supabase `options.data` (copied by the handle_new_user trigger). */
export const LEGAL_SIGNUP_META = { terms: 'terms_version', privacy: 'privacy_version' } as const;
/** POST /v1/account/legal/accept (OAuth sign-ups and re-acceptance). Versions must equal the server's LEGAL_*_VERSION. */
export const legalAcceptInputSchema = z.object({ termsVersion: legalVersionSchema, privacyVersion: legalVersionSchema });
export type LegalAcceptInput = z.infer<typeof legalAcceptInputSchema>;
export const legalStatusSchema = z.object({
  termsVersion: z.string(),
  privacyVersion: z.string(),
  acceptedTermsVersion: z.string().nullable(),
  acceptedPrivacyVersion: z.string().nullable(),
  acceptedAt: timestampSchema.nullable(),
  /** True when either accepted version differs from the current one. */
  needsAcceptance: z.boolean(),
});
export type LegalStatus = z.infer<typeof legalStatusSchema>;
