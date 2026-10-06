// Dev-only: 3 blog drafts (one per template) + category intros for review. Idempotent (upsert by slug); never run in production.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { renderPostSummary } from '@remoa/blog';
import { db } from './client';
import { blogCategories, blogPosts } from './schema';
import { blogDrafts, categoryIntros } from './seed/blog-drafts';

if (process.env.NODE_ENV === 'production') throw new Error('seed-blog is dev-only');

for (const [slug, intro] of Object.entries(categoryIntros)) {
  // intro_draft stays true; a human-approved intro (intro_draft = false) is never overwritten.
  await db.update(blogCategories).set({ intro }).where(and(eq(blogCategories.slug, slug), eq(blogCategories.introDraft, true)));
}

for (const d of blogDrafts) {
  const [cat] = await db.select({ id: blogCategories.id }).from(blogCategories).where(eq(blogCategories.slug, d.categorySlug));
  const s = renderPostSummary(d.content, { image: () => null });
  const [row] = await db.select({ id: blogPosts.id, status: blogPosts.status }).from(blogPosts).where(and(eq(blogPosts.slug, d.slug), isNull(blogPosts.deletedAt)));
  if (row && row.status !== 'draft') continue; // never touch a post someone published
  const values = {
    title: d.title, seoTitle: d.seoTitle, description: d.description, template: d.template, categoryId: cat?.id ?? null, focusKeyword: d.focusKeyword,
    contentJson: d.content, contentHtml: s.html, tocJson: s.toc, faq: s.faq, wordCount: s.wordCount, readingMinutes: s.readingMinutes,
    status: 'draft', contentUpdatedAt: sql`now()`, updatedAt: new Date(),
  };
  if (row) await db.update(blogPosts).set(values).where(eq(blogPosts.id, row.id));
  else await db.insert(blogPosts).values({ ...values, slug: d.slug });
}
process.stdout.write(`seed blog ok: ${blogDrafts.length} drafts, ${Object.keys(categoryIntros).length} category intros\n`);
process.exit(0);
