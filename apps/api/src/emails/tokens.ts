// G18 F24 FR-5: signed one-click unsubscribe tokens (D-763). Validated by GET/POST /v1/emails/unsubscribe?token= (lane C).
// No expiry on purpose: an old e-mail must still unsubscribe, and the only effect is turning a notice off.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@remoa/config';
import { notificationPrefKeys } from '@remoa/contracts';

/**
 * What the link turns off:
 * - a NotificationPrefKey (user): set that row's e-mail channel off ('store' also means "Sair da lista": leave store_waitlist);
 * - 'pause' (user): user_preferences.notif_pause_reminders = true;
 * - 'referral_invite' (address hash): email_suppressions reason invite_opt_out;
 * - 'landing_waitlist' (address hash): leave the public landing waitlist.
 */
export const unsubscribeScopes = [...notificationPrefKeys, 'pause', 'referral_invite', 'landing_waitlist'] as const;
export type UnsubscribeScope = (typeof unsubscribeScopes)[number];
export type UnsubscribeSubject = { userId: string } | { emailHash: string };
export type UnsubscribeClaim = { subject: UnsubscribeSubject; scope: UnsubscribeScope; legacy: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ADDRESS_SCOPES: readonly UnsubscribeScope[] = ['referral_invite', 'landing_waitlist'];

const mac = (msg: string) => createHmac('sha256', env().emailUnsubscribeSecret).update(msg).digest('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const idOf = (s: UnsubscribeSubject) => ('userId' in s ? s.userId : s.emailHash);

/** `subject.scope.sig`; the MAC is domain-separated ("unsub:") from the legacy `id.sig` tokens and from the .ics tokens ("ics:"). */
export function signUnsubscribeToken(subject: UnsubscribeSubject, scope: UnsubscribeScope): string {
  const id = idOf(subject);
  return `${id}.${scope}.${mac(`unsub:${id}.${scope}`)}`;
}

/**
 * New tokens, plus the F13/F18 ones already in inboxes (`account/reminders.ts`): `userId.sig` meant "turn the daily review reminder off"
 * and `emailHash.sig` meant "no more referral invites". Same secret (EMAIL_UNSUBSCRIBE_SECRET, else the legacy UNSUBSCRIBE_SECRET).
 */
export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const parts = token.split('.');
  if (parts.length === 2) {
    const [id = '', sig = ''] = parts;
    if (!same(sig, mac(id))) return null;
    if (UUID.test(id)) return { subject: { userId: id }, scope: 'review_reminder', legacy: true };
    if (HASH.test(id)) return { subject: { emailHash: id }, scope: 'referral_invite', legacy: true };
    return null;
  }
  if (parts.length !== 3) return null;
  const [id = '', scope = '', sig = ''] = parts;
  if (!(unsubscribeScopes as readonly string[]).includes(scope) || !same(sig, mac(`unsub:${id}.${scope}`))) return null;
  const s = scope as UnsubscribeScope;
  const address = ADDRESS_SCOPES.includes(s);
  if (address ? !HASH.test(id) : !UUID.test(id)) return null;
  return { subject: address ? { emailHash: id } : { userId: id }, scope: s, legacy: false };
}

/** The one-click URL (body link and List-Unsubscribe). */
export const unsubscribeUrl = (subject: UnsubscribeSubject, scope: UnsubscribeScope) =>
  `${env().apiOrigin}/v1/emails/unsubscribe?token=${signUnsubscribeToken(subject, scope)}`;

