import { describe, expect, it } from 'vitest';
import { BLOG_FILE_KEY } from './public';

const id = '0b9d6c3e-6f2a-4c1e-9d7a-2f4b8e1c5a90';

describe('BLOG_FILE_KEY (/v1/public/blog/files/*)', () => {
  it('serves only keys written by the blog image pipeline', () => {
    for (const k of [`blog/${id}/sepse-640.webp`, `blog/${id}/sepse-1600.avif`, `blog/${id}/sepse-og.jpg`, `blog/${id}/-640.webp`]) expect(BLOG_FILE_KEY.test(k)).toBe(true);
  });
  it('never private user files or traversal', () => {
    for (const k of [
      `uploads/${id}/x.webp`, `assets/${id}/${id}/w800.webp`, `avatars/${id}/raw/x.png`, `support/${id}/x`, `imports/${id}/x.apkg`,
      `blog/${id}/../../uploads/${id}/x.webp`, `blog/${id}/x-640.png`, `blog/x/sepse-640.webp`, `/blog/${id}/sepse-640.webp`,
    ]) expect(BLOG_FILE_KEY.test(k)).toBe(false);
  });
});
