// D-1443: POST /v1/imports/anki/direct with the storage mocked (the real multipart path is in routes/imports.test.ts).
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APKG_MAX_BYTES } from '@remoa/contracts';

const stored: { key: string; bytes: number }[] = [];
vi.mock('../storage/storage', () => ({
  putStream: vi.fn(async (key: string, body: AsyncIterable<Uint8Array>) => {
    let bytes = 0;
    for await (const c of body) bytes += c.byteLength; // drains like the real upload: 413 must come from the cut, not the mock
    stored.push({ key, bytes });
  }),
  getBytes: vi.fn(), headObject: vi.fn(), presignPut: vi.fn(), putBytes: vi.fn(),
}));
let overQuota = false;
vi.mock('../billing/quota', () => ({ overAnkiImports: async () => overQuota, limitFor: vi.fn(), overTotal: vi.fn() }));

const { createImports } = await import('./imports');
const { importsRoutes } = await import('../routes/imports');
const { UPLOAD_SIGN_PER_HOUR } = await import('../uploads/rate-limit');

const app = (userId: string) =>
  new Hono()
    .use(async (c, next) => { c.set('userId' as never, userId as never); c.set('log' as never, { warn: () => undefined } as never); await next(); })
    .route('/', importsRoutes(createImports({ anki: {} as never })));

const MB = 1024 * 1024;
const zip = (n: number) => { const b = Buffer.alloc(n); b.set([0x50, 0x4b, 0x03, 0x04]); return b; };
/** A lazily generated body of `total` bytes (1 MB chunks); `pulled()` = how much the server actually read. */
const lazy = (total: number) => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= total) return c.close();
      const n = Math.min(MB, total - pulled);
      c.enqueue(pulled === 0 ? zip(n) : new Uint8Array(n));
      pulled += n;
    },
  });
  return { stream, pulled: () => pulled };
};
const post = (userId: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app(userId).request('/anki/direct', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers }, duplex: 'half' } as RequestInit);

describe('D-1443 /anki/direct', () => {
  beforeEach(() => { stored.length = 0; overQuota = false; });

  it('streams a zip to imports/{uid}/ and returns { key }', async () => {
    const res = await post('u1', zip(3 * MB));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { key: string } };
    expect(data.key).toMatch(/^imports\/u1\/[0-9a-f-]{36}\.apkg$/);
    expect(stored).toEqual([{ key: data.key, bytes: 3 * MB }]);
  });

  it('cuts a 300 MB chunked body at the cap with 413, without reading it all', async () => {
    const body = lazy(300 * MB);
    const res = await post('u2', body.stream);
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(APKG_MAX_BYTES + 2 * MB);
    expect(body.pulled()).toBeGreaterThan(APKG_MAX_BYTES); // really streamed up to the cap
  });

  it('refuses a declared Content-Length above the cap before reading anything', async () => {
    const body = lazy(300 * MB);
    const res = await post('u3', body.stream, { 'content-length': String(APKG_MAX_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(body.pulled()).toBeLessThanOrEqual(MB);
    expect(stored).toEqual([]);
  });

  it('refuses a non-zip (and an empty body) with 422', async () => {
    for (const b of [Buffer.from('SQLite format 3\0'), Buffer.from('PK'), Buffer.alloc(0)]) {
      const res = await post('u4', b);
      expect(res.status).toBe(422);
    }
    expect(stored).toEqual([]);
  });

  it('magic split across chunks still passes', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(0x50, 0x4b)); c.enqueue(Uint8Array.of(0x03, 0x04, 1, 2)); c.close(); } });
    expect((await post('u5', stream)).status).toBe(200);
    expect(stored[0]!.bytes).toBe(6);
  });

  it('quota (D-648) and per-user rate limit come before the body', async () => {
    overQuota = true;
    expect((await post('u6', zip(10))).status).toBe(402);
    overQuota = false;
    for (let i = 0; i < UPLOAD_SIGN_PER_HOUR; i++) await post('u7', zip(10));
    expect((await post('u7', zip(10))).status).toBe(429);
  });
});
