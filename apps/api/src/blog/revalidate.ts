import type { Logger } from '@remoa/log';
import { invalidate } from '../cache';

// F27 FR-21/FR-33 (D-907): the blog's tag revalidation is the generic web revalidation of the cache module (G21 T6, D-980).
export { revalidateWeb as revalidateBlog } from '../cache/revalidate-web';

const pick = (tags: string[], prefix: string) => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
/** G21 T7: the blog's post/category tags (Fx.tags, D-908) as the `blog.changed` event; the catalog adds blog, landing, sitemap and feed. */
export const blogChanged = (tags: string[], log?: Logger) => invalidate('blog.changed', { slugs: pick(tags, 'blog:post:'), categorySlugs: pick(tags, 'blog:category:') }, log);
