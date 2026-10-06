// G19 F27 FR-10: preview link = base64url({ p: postId, e: expiresAtMs }).HMAC-SHA256 (BLOG_PREVIEW_SECRET). Stateless, valid 24 h.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@remoa/config';
import { BLOG_LIMITS, type PreviewLink } from '@remoa/contracts';

const sign = (payload: string) => createHmac('sha256', env().blogPreviewSecret).update(payload).digest('base64url');

export function signPreview(postId: string, now = Date.now()): PreviewLink {
  const exp = now + BLOG_LIMITS.previewHours * 3_600_000;
  const payload = Buffer.from(JSON.stringify({ p: postId, e: exp })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  return { token, url: `${env().siteUrl.replace(/\/+$/, '')}/preview/blog/${token}`, expiresAt: new Date(exp) };
}

/** Post id, or null when forged, malformed or expired. */
export function verifyPreview(token: string, now = Date.now()): string | null {
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { p?: unknown; e?: unknown };
    return typeof p === 'string' && typeof e === 'number' && e > now ? p : null;
  } catch {
    return null;
  }
}
