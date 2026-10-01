import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import {
  type AssetRef, type AssetView, type CompleteUpload, type GetAsset, type SignUpload,
  err, idSchema, imageMimes, ok,
} from '@remoa/contracts';
import { deleteObject, getBytes, headObject, presignGet, presignPut, putBytes } from '../storage/storage';
import { run } from '../db';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Decompression-bomb guard: 50 MP covers 48 MP phone cameras; two parallel decodes stay under ~400 MB. */
const PIXEL_LIMIT = 50e6;
const ext: Record<(typeof imageMimes)[number], string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const variants = { w800: 800, w1600: 1600 } as const;

export const signUpload: SignUpload = async (userId, input) => {
  const key = `uploads/${userId}/${crypto.randomUUID()}.${ext[input.mime]}`;
  return ok({ url: await presignPut(key, input.mime, input.sizeBytes), key });
};

export const completeUpload: CompleteUpload = async (userId, input) => {
  // Only the user's own, flat upload keys; anything else is someone else's object.
  if (!input.key.startsWith(`uploads/${userId}/`) || input.key.slice(`uploads/${userId}/`.length).includes('/')) {
    return err('forbidden', 'upload key is not yours');
  }
  const head = await headObject(input.key);
  if (!head) return err('not_found', 'upload not found');
  if (head.size > MAX_UPLOAD_BYTES || !(imageMimes as readonly string[]).includes(head.mime)) {
    await deleteObject(input.key);
    return err('validation', 'file too large or not a jpeg/png/webp image');
  }
  const original = await getBytes(input.key);
  // Content-Type is not signed in the presigned PUT: sniff the real format (rejects SVG/GIF/TIFF declared as png).
  const sniffed = await sharp(original).metadata().catch(() => null);
  if (!sniffed || !['jpeg', 'png', 'webp'].includes(sniffed.format ?? '')) {
    await deleteObject(input.key);
    return err('validation', 'file is not a jpeg/png/webp image');
  }
  const assetId = crypto.randomUUID();
  const base = `assets/${userId}/${assetId}`;
  let size: { width: number; height: number };
  try {
    const out = await Promise.all(
      (Object.entries(variants) as [keyof typeof variants, number][]).map(async ([name, width]) => {
        const { data, info } = await sharp(original, { limitInputPixels: PIXEL_LIMIT })
          .rotate()
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 75 })
          .toBuffer({ resolveWithObject: true });
        await putBytes(`${base}/${name}.webp`, data, 'image/webp');
        return { name, info };
      }),
    );
    const big = out.find((o) => o.name === 'w1600')!.info;
    size = { width: big.width, height: big.height };
  } catch (e) {
    await deleteObject(input.key);
    return err('validation', `could not process image: ${e instanceof Error ? e.message : 'invalid'}`);
  }
  const row = await run(userId, async (tx, s) => {
    const [r] = await tx
      .insert(s.assets)
      .values({ id: assetId, userId, key: base, mime: 'image/webp', ...size, license: input.license ?? 'own', attribution: input.attribution ?? null })
      .returning();
    return r!;
  });
  await deleteObject(input.key);
  return ok(toRef(row));
};

const toRef = (r: { id: string; key: string; mime: string; width: number | null; height: number | null; license: AssetRef['license']; attribution: string | null }): AssetRef => ({
  id: r.id, key: r.key, mime: r.mime as AssetRef['mime'], width: r.width ?? 1, height: r.height ?? 1, license: r.license, attribution: r.attribution,
});

/** RLS decides readability: own asset, or one used by a card the user can read. */
export const getAsset: GetAsset = async (userId, assetId) => {
  if (!idSchema.safeParse(assetId).success) return err('not_found', 'asset not found');
  const row = await run(userId, async (tx, s) => (await tx.select().from(s.assets).where(eq(s.assets.id, assetId)))[0]);
  if (!row) return err('not_found', 'asset not found');
  const [w800, w1600] = await Promise.all([presignGet(`${row.key}/w800.webp`), presignGet(`${row.key}/w1600.webp`)]);
  return ok({ ...toRef(row), urls: { w800, w1600 } } satisfies AssetView);
};
