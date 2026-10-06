import { Hono } from 'hono';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_MAX_BYTES } from '@remoa/contracts';

const put = vi.fn(async () => undefined);
vi.mock('../storage/storage', () => ({ putBytes: put, deletePrefix: vi.fn(), deleteObject: vi.fn(), getBytes: vi.fn(), headObject: vi.fn(), presignGet: vi.fn(), presignPut: vi.fn() }));
vi.mock('../db', () => ({ run: async () => ({ id: 'a', key: 'assets/u/a', mime: 'image/webp', width: 1600, height: 1200, license: 'own', attribution: null }) }));

const { processImage } = await import('./uploads');
const { imageBodyLimit } = await import('../routes/uploads');

describe('D-1202 direct image upload', () => {
  it('stores only the compressed WebP variants, never the original', async () => {
    const jpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#7c3aed' } }).jpeg().toBuffer();
    const r = await processImage('u', jpeg, { license: 'own' });
    expect(r.ok).toBe(true);
    const keys = put.mock.calls.map((c) => (c as unknown[])[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => /^assets\/u\/[0-9a-f-]{36}\/w(800|1600)\.webp$/.test(k))).toBe(true);
  });

  it('rejects a non-image disguised as one (SVG)', async () => {
    const r = await processImage('u', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {});
    expect(r).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('answers 413 above 100 MB before reading the body', async () => {
    const app = new Hono().post('/x', imageBodyLimit, (c) => c.text('ok'));
    const res = await app.request('/x', { method: 'POST', body: 'x', headers: { 'content-length': String(IMAGE_MAX_BYTES + 1024 * 1024) } });
    expect(res.status).toBe(413);
    expect((await app.request('/x', { method: 'POST', body: 'x' })).status).toBe(200);
  });
});
