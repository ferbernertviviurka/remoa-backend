import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { err, ok, SUPPORT_LIMITS, supportErrors, type Result, type SignSupportAttachment } from '@remoa/contracts';
import { dbm } from '../db';
import { deleteObject, getBytes, headObject, presignGet, presignPut, putBytes } from '../storage/storage';

export type StoredAttachment = { key: string; mime: 'image/png' | 'image/jpeg'; size: number };
const bad = () => err('validation', supportErrors.badAttachment);
const PIXEL_LIMIT = 50e6;

/** FR-5: key `support/<userId>/<uuid>`, PUT signed with the declared size (<= 5 MB by contract). */
export const signSupportAttachment: SignSupportAttachment = async (userId, input) => {
  const key = `support/${userId}/${crypto.randomUUID()}`;
  return ok({ url: await presignPut(key, input.mime, input.sizeBytes), key });
};

/** Real format from magic bytes (the declared Content-Type is not trusted). */
export const sniff = (b: Buffer): StoredAttachment['mime'] | null =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg' : null;

/**
 * On submit: owner prefix, size, magic bytes, then re-encode without metadata (EXIF/GPS gone; `.rotate()` bakes the
 * orientation in first) and overwrite the object. Any failure deletes the offending upload.
 */
export async function processAttachments(userId: string, keys: string[]): Promise<Result<StoredAttachment[]>> {
  if (keys.length > SUPPORT_LIMITS.attachmentsMax) return bad();
  const prefix = `support/${userId}/`;
  if (keys.some((k) => !k.startsWith(prefix) || k.slice(prefix.length).includes('/') || k.includes('..'))) return bad();
  const { db, supportAttachments } = await dbm();
  if (keys.length && (await db.select({ id: supportAttachments.id }).from(supportAttachments).where(inArray(supportAttachments.key, keys))).length) return bad(); // already used
  const out: StoredAttachment[] = [];
  for (const key of keys) {
    const head = await headObject(key);
    if (!head) return bad();
    if (head.size > SUPPORT_LIMITS.attachmentMaxBytes) {
      await deleteObject(key);
      return bad();
    }
    const raw = await getBytes(key);
    const mime = sniff(raw);
    if (!mime) {
      await deleteObject(key);
      return bad();
    }
    try {
      const img = sharp(raw, { limitInputPixels: PIXEL_LIMIT }).rotate();
      const data = await (mime === 'image/png' ? img.png() : img.jpeg({ quality: 90 })).toBuffer();
      // Fresh key: the signed PUT for `key` stays valid for 10 min, so the clean copy must not be re-writable by the user.
      const clean = `${prefix}${crypto.randomUUID()}`;
      await putBytes(clean, data, mime);
      await deleteObject(key);
      out.push({ key: clean, mime, size: data.length });
    } catch {
      await deleteObject(key);
      return bad();
    }
  }
  return ok(out);
}

/** Signed short-lived GET (1 h), only ever called for the owner's or an admin's view. */
export const attachmentsOf = async (ticketId: string, messageIds?: string[]) => {
  const { db, supportAttachments } = await dbm();
  const rows = await db.select().from(supportAttachments).where(eq(supportAttachments.ticketId, ticketId));
  const wanted = messageIds ? rows.filter((r) => messageIds.includes(r.messageId)) : rows;
  return Promise.all(wanted.map(async (r) => ({ messageId: r.messageId, id: r.id, mime: r.mime as StoredAttachment['mime'], sizeBytes: r.size, url: await presignGet(r.key) })));
};
