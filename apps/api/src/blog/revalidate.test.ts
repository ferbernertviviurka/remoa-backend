import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@remoa/config';
import { revalidateBlog } from './revalidate';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const mockFetch = (...results: (number | Error)[]) => {
  const f = vi.fn();
  for (const r of results) f.mockImplementationOnce(async () => (r instanceof Error ? Promise.reject(r) : new Response(null, { status: r })));
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('revalidateBlog (F27 FR-21)', () => {
  it('posts the de-duplicated tags with the Bearer secret', async () => {
    const f = mockFetch(200);
    await revalidateBlog(['blog', 'sitemap', 'blog'], log);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(env().revalidateUrl);
    expect(init.headers.authorization).toBe(`Bearer ${env().revalidateSecret}`);
    expect(JSON.parse(init.body)).toEqual({ tags: ['blog', 'sitemap'] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries once on a network error or 5xx, then logs and resolves', async () => {
    const f = mockFetch(new Error('ECONNREFUSED'), 503);
    await expect(revalidateBlog(['feed'], log)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('blog revalidate failed', expect.objectContaining({ error: 'status 503' }));
  });

  it('recovers on the retry', async () => {
    const f = mockFetch(500, 200);
    await revalidateBlog(['feed'], log);
    expect(f).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not retry a 401 and never throws', async () => {
    const f = mockFetch(401);
    await revalidateBlog(['feed'], log);
    expect(f).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('skips invalid input without calling the web', async () => {
    const f = mockFetch();
    await revalidateBlog([], log);
    expect(f).not.toHaveBeenCalled();
  });
});
