import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES, err, imageMimes, ok, type AvatarVariants, type ConfirmAvatar, type RemoveAvatar } from '@remoa/contracts';
import { recordEvent } from './events';
import { deleteObject, getBytes, headObject, presignGet, putBytes } from '../storage/storage';

/** D-055: decompression-bomb guard, same as card images. */
const PIXEL_LIMIT = 50e6;
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
  const original = await getBytes(key);
  // Content-Type is not signed: sniff the real format (rejects SVG/GIF/TIFF declared as png).
  const sniffed = await sharp(original, { limitInputPixels: PIXEL_LIMIT }).metadata().catch(() => null);
  const formats: readonly string[] = imageMimes.map((m) => m.split('/')[1]!);
  if (!sniffed || !formats.includes(sniffed.format ?? '')) {
    await deleteObject(key);
    return err('validation', 'file is not a jpeg/png/webp image');
  }
  const large = `avatars/${userId}/${crypto.randomUUID()}/512.webp`;
  try {
    // No withMetadata(): sharp drops EXIF/ICC by default. rotate() applies orientation before it is lost.
    const enc = (size: number) =>
      sharp(original, { limitInputPixels: PIXEL_LIMIT }).rotate().resize(size, size, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
    const [b512, b96] = await Promise.all([enc(512), enc(96)]);
    await Promise.all([putBytes(large, b512, 'image/webp'), putBytes(small(large), b96, 'image/webp')]);
  } catch {
    await deleteObject(key);
    return err('validation', 'invalid_image');
  }
  const prev = await setKey(userId, large, 'upload');
  await Promise.all([deleteObject(key), dropVariants(prev)]);
  return ok(await signAvatarUrls(large));
};

export const removeAvatar: RemoveAvatar = async (userId) => {
  const prev = await setKey(userId, null, 'removed');
  await dropVariants(prev);
  return ok(null);
};
