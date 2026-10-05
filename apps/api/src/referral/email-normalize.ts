import { createHash } from 'node:crypto';

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** D-386: lowercase, no `+tag`, no dots in Gmail (googlemail.com = gmail.com). Shared with antifraud. */
export const normalizeEmail = (raw: string) => {
  const [local = '', domain = ''] = raw.trim().toLowerCase().split('@');
  const noTag = local.split('+')[0] ?? local;
  return GMAIL.has(domain) ? `${noTag.replaceAll('.', '')}@gmail.com` : `${noTag}@${domain}`;
};
export const emailHash = (raw: string) => createHash('sha256').update(normalizeEmail(raw)).digest('hex');
/** "daniel@gmail.com" -> "d***@gmail.com" (original local part, not the normalized one). */
export const maskEmail = (raw: string) => {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  return `${e.slice(0, 1)}***${e.slice(at)}`;
};
