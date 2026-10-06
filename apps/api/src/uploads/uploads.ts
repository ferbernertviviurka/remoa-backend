import { eq } from 'drizzle-orm';
import { pick } from '../pick';
import sharp from 'sharp';
import {
  type AssetRef, type AssetView, type CompleteUpload, type GetAsset, type Result, type SignUpload,
  IMAGE_MAX_BYTES, err, idSchema, imageMimes, ok,
} from '@remoa/contracts';
import { deleteObject, deletePrefix, getBytes, headObject, presignGet, presignPut, putBytes } from '../storage/storage';
import { run } from '../db';

/** AI uploads (PDF/board generation in routes/ai.ts); images use IMAGE_MAX_BYTES. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Decompression-bomb guard: 100 MP covers 100 MB camera/scanner photos; variants decode one at a time (~400 MB peak). */
export const PIXEL_LIMIT = 100e6;
const ext: Record<(typeof imageMimes)[number], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const variants = { w800: 800, w1600: 1600 } as const;

export const signUpload: SignUpload = async (userId, input) => {
  // F13: avatars go under their own raw prefix; account/avatar.ts confirms them (size cap is enforced by the contract and the signed Content-Length).
  const key = `${input.kind === 'avatar' ? `avatars/${userId}/raw` : `uploads/${userId}`}/${crypto.randomUUID()}.${ext[input.mime]}`;
  return ok({ url: await presignPut(key, input.mime, input.sizeBytes), key });
};

export const completeUpload: CompleteUpload = async (userId, input) => {
  // Only the user's own, flat upload keys; anything else is someone else's object.
  if (!input.key.startsWith(`uploads/${userId}/`) || input.key.slice(`uploads/${userId}/`.length).includes('/')) {
    return err('forbidden', 'upload key is not yours');
  }
  const head = await headObject(input.key);
  if (!head) return err('not_found', 'upload not found');
  if (head.size > IMAGE_MAX_BYTES || !(imageMimes as readonly string[]).includes(head.mime)) {
    await deleteObject(input.key);
    return err('validation', 'file too large or not a jpeg/png/webp image');
  }
  const r = await processImage(userId, await getBytes(input.key), input);
  await deleteObject(input.key);
  return r;
};

/**
 * Bytes -> assets/<user>/<id>/{w800,w1600}.webp + assets row. Only the WebP variants are stored, never the original.
 * Used by /complete (presigned original) and /direct (multipart, D-1202).
 */
export async function processImage(userId: string, original: Buffer, meta: { license?: AssetRef['license']; attribution?: string | null }): Promise<Result<AssetRef>> {
  // The declared Content-Type is never trusted: sniff the real format (rejects SVG/GIF/TIFF declared as png).
  const sniffed = await sharp(original, { limitInputPixels: PIXEL_LIMIT }).metadata().catch(() => null);
  if (!sniffed || !['jpeg', 'png', 'webp'].includes(sniffed.format ?? '')) return err('validation', 'file is not a jpeg/png/webp image');
  const assetId = crypto.randomUUID();
  const base = `assets/${userId}/${assetId}`;
  let size = { width: 1, height: 1 };
  try {
    // Sequential: a 100 MB photo decodes to hundreds of MB; two parallel decodes could OOM the Railway container.
    for (const [name, width] of Object.entries(variants)) {
      const { data, info } = await sharp(original, { limitInputPixels: PIXEL_LIMIT })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer({ resolveWithObject: true });
      await putBytes(`${base}/${name}.webp`, data, 'image/webp');
      if (name === 'w1600') size = { width: info.width, height: info.height };
    }
  } catch (e) {
    await deletePrefix(`${base}/`).catch(() => undefined);
    return err('validation', `could not process image: ${e instanceof Error ? e.message : 'invalid'}`);
  }
  const row = await run(userId, async (tx, s) => {
    const [r] = await tx
      .insert(s.assets)
      .values({ id: assetId, userId, key: base, mime: 'image/webp', ...size, license: meta.license ?? 'own', attribution: meta.attribution ?? null })
      .returning();
    return r!;
  });
  return ok(toRef(row));
}

const toRef = (r: { id: string; key: string; mime: string; width: number | null; height: number | null; license: AssetRef['license']; attribution: string | null }): AssetRef => ({
  id: r.id, key: r.key, mime: r.mime as AssetRef['mime'], width: r.width ?? 1, height: r.height ?? 1, license: r.license, attribution: r.attribution,
});

/** RLS decides readability: own asset, or one used by a card the user can read. */
export const getAsset: GetAsset = async (userId, assetId) => {
  if (!idSchema.safeParse(assetId).success) return err('not_found', 'asset not found');
  const row = await run(userId, async (tx, s) => (await tx.select(pick(s.assets, 'id', 'key', 'mime', 'width', 'height', 'license', 'attribution')).from(s.assets).where(eq(s.assets.id, assetId)))[0]);
  if (!row) return err('not_found', 'asset not found');
  const [w800, w1600] = await Promise.all([presignGet(`${row.key}/w800.webp`), presignGet(`${row.key}/w1600.webp`)]);
  return ok({ ...toRef(row), urls: { w800, w1600 } } satisfies AssetView);
};
