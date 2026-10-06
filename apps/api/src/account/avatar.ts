import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES, err, imageMimes, ok, type AvatarVariants, type ConfirmAvatar, type RemoveAvatar, type Result } from '@remoa/contracts';
import { recordEvent } from './events';
import { deleteObject, getBytes, headObject, presignGet, putBytes } from '../storage/storage';
import { invalidate } from '../cache';
import { PIXEL_LIMIT } from '../uploads/uploads';
// Layout: avatars/<uid>/raw/<uuid>.<ext> (upload), avatars/<uid>/<id>/512.webp + 96.webp (processed; profiles.avatar_key = the 512 one).
const small = (largeKey: string) => largeKey.replace(/512\.webp$/, '96.webp');

/** Signed URLs, 1 h (presignGet's expiry = ACCOUNT_LIMITS.avatarUrlSeconds). */
export const signAvatarUrls = async (key: string): Promise<AvatarVariants> => {
  const [large, sm] = await Promise.all([presignGet(key), presignGet(small(key))]);
  return { large, small: sm };
};

const dropVariants = async (largeKey: string | null | undefined) => {
  if (largeKey) await Promise.all([deleteObject(largeKey), deleteObject(small(largeKey))]);
};

const setKey = async (userId: string, avatarKey: string | null, source: 'upload' | 'removed') => {
  const { db, profiles } = await import('@remoa/db');
  const [prev] = await db.select({ k: profiles.avatarKey }).from(profiles).where(eq(profiles.userId, userId));
  await db.insert(profiles).values({ userId, avatarKey }).onConflictDoUpdate({ target: profiles.userId, set: { avatarKey } });
  // ponytail: direct insert until account/events.ts (recordEvent) lands; swap then.
  await recordEvent(db, userId, 'avatar_changed', { source, zoom: null });
  await invalidate('profile.changed', { userId });
  return prev?.k ?? null;
};

export const confirmAvatar: ConfirmAvatar = async (userId, { key }) => {
  const prefix = `avatars/${userId}/raw/`;
  if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) return err('forbidden', 'upload key is not yours');
  const head = await headObject(key);
  if (!head) return err('not_found', 'upload not found');
  if (head.size > AVATAR_MAX_BYTES) {
    await deleteObject(key);
    return err('validation', 'avatar too large');
  }
  const r = await processAvatar(userId, await getBytes(key));
  await deleteObject(key);
  return r;
};

/** Bytes -> avatars/<uid>/<id>/{512,96}.webp; only these are stored, never the original (D-1202). */
export async function processAvatar(userId: string, original: Buffer): Promise<Result<AvatarVariants>> {
  // The declared Content-Type is never trusted: sniff the real format (rejects SVG/GIF/TIFF declared as png).
  const sniffed = await sharp(original, { limitInputPixels: PIXEL_LIMIT }).metadata().catch(() => null);
  const formats: readonly string[] = imageMimes.map((m) => m.split('/')[1]!);
  if (!sniffed || !formats.includes(sniffed.format ?? '')) return err('validation', 'file is not a jpeg/png/webp image');
  const large = `avatars/${userId}/${crypto.randomUUID()}/512.webp`;
  try {
    // No withMetadata(): sharp drops EXIF/ICC by default. rotate() applies orientation before it is lost. Sequential: big photos.
    const enc = (size: number) =>
      sharp(original, { limitInputPixels: PIXEL_LIMIT }).rotate().resize(size, size, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
    await putBytes(large, await enc(512), 'image/webp');
    await putBytes(small(large), await enc(96), 'image/webp');
  } catch {
    await dropVariants(large).catch(() => undefined);
    return err('validation', 'invalid_image');
  }
  const prev = await setKey(userId, large, 'upload');
  await dropVariants(prev);
  return ok(await signAvatarUrls(large));
}

export const removeAvatar: RemoveAvatar = async (userId) => {
  const prev = await setKey(userId, null, 'removed');
  await dropVariants(prev);
  return ok(null);
};
