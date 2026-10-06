import { describe, expect, it } from 'vitest';
import { countWords, docHrefs, isExternalHref, isInternalHref, publishBlockers, extractFaq, BLOG_LIMITS } from '@remoa/contracts';
import { renderPostSummary } from '@remoa/blog';
import { blogDrafts, categoryIntros } from './blog-drafts';

describe('blog drafts', () => {
  it('one per template, long enough, with FAQ, callout, internal and external links, no cover', () => {
    expect(blogDrafts.map((d) => d.template).sort()).toEqual(['destaque', 'guia', 'leitura']);
    for (const d of blogDrafts) {
      expect(countWords(d.content)).toBeGreaterThanOrEqual(600);
      expect(extractFaq(d.content).length).toBeGreaterThan(0);
      expect(d.content.content.some((b) => b.type === 'callout')).toBe(true);
      const hrefs = docHrefs(d.content);
      expect(hrefs).toEqual(expect.arrayContaining(['/blog', '/cadastro']));
      expect(hrefs.some(isInternalHref) && hrefs.some(isExternalHref)).toBe(true);
      expect(d.content.content.some((b) => b.type === 'heading' && b.attrs.level === 3)).toBe(true);
      expect(d.seoTitle.length).toBeLessThanOrEqual(BLOG_LIMITS.seoTitleMax);
      expect(d.description.length).toBeLessThanOrEqual(BLOG_LIMITS.descriptionCounter);
      expect(renderPostSummary(d.content, { image: () => null }).html).toContain('<h2');
      // no cover on purpose: blocked from publishing until a human adds one
      expect(publishBlockers({ ...d, coverAlt: '' })).toEqual(['cover']);
    }
  });
  it('category intros have 150-300 words', () => {
    expect(Object.keys(categoryIntros)).toHaveLength(4);
    for (const t of Object.values(categoryIntros)) {
      expect(countWords(t)).toBeGreaterThanOrEqual(150);
      expect(countWords(t)).toBeLessThanOrEqual(300);
    }
  });
});
