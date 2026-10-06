// G19 F27 FR-26 (D-908): blog image pipeline. Signature check (not Content-Type), EXIF stripped by re-encoding after `.rotate()`,
// WebP + AVIF variants (no upscale), a 1200x630 JPEG crop for social cards, public bucket, row in blog_assets.
import { eq, sql } from 'drizzle-orm';
import { pick } from '../pick';
import sharp from 'sharp';
import { env } from '@remoa/config';
import { BLOG_LIMITS, blogErrors, err, ok, slugify, type BlogAsset, type BlogAssetVariant, type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { dbm, uuids } from '../db';
import { putPublicBytes } from '../storage/storage';
import type { ImageRef, ResolvedImage } from '@remoa/blog';

const PIXEL_LIMIT = 25e6;
const SIGNATURES: { mime: string; format: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', format: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', format: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', format: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

const baseUrl = () => env().r2PublicBaseUrl.replace(/\/+$/, '');
const urlOf = (key: string) => `${baseUrl()}/${key.split('/').map(encodeURIComponent).join('/')}`;

export const ASSET_COLS = ['id', 'key', 'width', 'height', 'mime', 'size', 'variants'] as const;
type AssetRow = { id: string; key: string; width: number; height: number; mime: string; size: number; variants: unknown };

/** DB row → API shape (public URLs, ready-made srcsets). */
export function assetDto(a: AssetRow): BlogAsset {
  const vs = a.variants as BlogAssetVariant[];
  const set = (f: 'webp' | 'avif') => vs.filter((v) => v.format === f).sort((x, y) => x.width - y.width).map((v) => `${urlOf(v.key)} ${v.width}w`).join(', ');
  const og = vs.find((v) => v.format === 'jpeg');
  return { id: a.id, url: urlOf(a.key), width: a.width, height: a.height, mime: a.mime, size: a.size, srcset: { webp: set('webp'), avif: set('avif') }, ogUrl: og ? urlOf(og.key) : null };
}

/** For `renderPostHtml`: assetId → {src, srcset, sizes, width, height}; external `src` passes through; unknown asset = null (image dropped). */
export function blogImageResolver(assets: AssetRow[], externals: Map<string, { width: number; height: number }> = new Map()) {
  const byId = new Map(assets.map((a) => [a.id, assetDto(a)]));
  return (ref: ImageRef): ResolvedImage | null => {
    if (ref.assetId) {
      const a = byId.get(ref.assetId);
      return a ? { src: a.url, srcset: a.srcset.webp, sizes: '(min-width: 768px) 720px, 100vw', width: a.width, height: a.height } : null;
    }
    const ext = ref.src ? externals.get(ref.src) : undefined;
    return ext && ref.src ? { src: ref.src, ...ext } : null;
  };
}

/** Loads the assets an HTML render needs. */
export async function loadAssets(ids: string[]): Promise<AssetRow[]> {
  if (!ids.length) return [];
  const { db, blogAssets } = await dbm();
  return db.select(pick(blogAssets, ...ASSET_COLS)).from(blogAssets).where(sql`${blogAssets.id} = any(${uuids(ids)})`);
}

export async function uploadBlogImage(userId: string, input: { bytes: Buffer; slug: string; id?: string }, tx?: Tx): Promise<Result<{ asset: BlogAsset }>> {
  const { bytes } = input;
  if (!bytes.length || bytes.length > BLOG_LIMITS.imageMaxBytes) return err('validation', blogErrors.badImage);
  const sig = SIGNATURES.find((s) => s.test(bytes));
  if (!sig) return err('validation', blogErrors.badImage);
  const slug = slugify(input.slug) || 'imagem';

  let base: Buffer;
  let w: number;
  let h: number;
  try {
    // rotate() applies EXIF orientation; sharp drops all metadata (EXIF, ICC, XMP) on output unless asked to keep it.
    const r = await sharp(bytes, { limitInputPixels: PIXEL_LIMIT }).rotate().png().toBuffer({ resolveWithObject: true });
    if (!r.info.width || !r.info.height) return err('validation', blogErrors.badImage);
    ({ data: base, info: { width: w, height: h } } = r);
  } catch {
    return err('validation', blogErrors.badImage);
  }

  const widths: number[] = BLOG_LIMITS.imageWidths.filter((x) => x <= w);
  if (!widths.includes(w) && w < 1600) widths.push(w);
  if (!widths.length) widths.push(w);
  widths.sort((a, b) => a - b);

  const id = input.id ?? crypto.randomUUID();
  const dir = `blog/${id}`;
  const variants: BlogAssetVariant[] = [];
  const puts: Promise<unknown>[] = [];
  for (const width of widths) {
    const height = Math.round((h * width) / w);
    for (const f of ['webp', 'avif'] as const) {
      const key = `${dir}/${slug}-${width}.${f}`;
      variants.push({ key, width, height, format: f });
      const img = sharp(base).resize({ width, withoutEnlargement: true });
      puts.push((f === 'webp' ? img.webp({ quality: 78 }) : img.avif({ quality: 55 })).toBuffer().then((b) => putPublicBytes(key, b, `image/${f}`)));
    }
  }
  const ogKey = `${dir}/${slug}-og.jpg`;
  variants.push({ key: ogKey, width: BLOG_LIMITS.og.width, height: BLOG_LIMITS.og.height, format: 'jpeg' });
  puts.push(sharp(base).resize(BLOG_LIMITS.og.width, BLOG_LIMITS.og.height, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer().then((b) => putPublicBytes(ogKey, b, 'image/jpeg')));
  await Promise.all(puts);

  const main = variants.filter((v) => v.format === 'webp').at(-1)!;
  const { db, blogAssets } = await dbm();
  const [row] = await (tx ?? db).insert(blogAssets).values({ id, key: main.key, width: main.width, height: main.height, mime: 'image/webp', size: bytes.length, variants, createdBy: userId }).returning();
  return ok({ asset: assetDto(row!) });
}

export const getAsset = async (id: string) => {
  const { db, blogAssets } = await dbm();
  return (await db.select(pick(blogAssets, ...ASSET_COLS)).from(blogAssets).where(eq(blogAssets.id, id)))[0] ?? null;
};
