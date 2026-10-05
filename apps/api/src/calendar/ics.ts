import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '@remoa/config';
import { CALENDAR_LIMITS, err, idSchema, ok, type Result } from '@remoa/contracts';
import { dbm } from '../db';
import { presignGet } from '../storage/storage';
import { localCols } from './common';

// FR-18: the file carries the event only, never a VALARM (the reminders are ours). Timed events in UTC, all-day as DATE.

const mac = (eventId: string, domain: 'ics' | 'cover' = 'ics') => createHmac('sha256', env().emailUnsubscribeSecret).update(`${domain}:${eventId}`).digest('base64url');

/** `eventId.hmac`: no expiry (an old e-mail keeps adding to the calendar), domain-separated by the `ics:` prefix. */
export const icsToken = (eventId: string) => `${eventId}.${mac(eventId)}`;
export const icsUrlFor = (eventId: string) => `${env().apiOrigin}/v1/public/calendar/${icsToken(eventId)}.ics`;
const eventOf = (token: string, domain: 'ics' | 'cover'): string | null => {
  const [id = '', sig = '', ...rest] = token.split('.');
  if (rest.length || !idSchema.safeParse(id).success) return null;
  const want = Buffer.from(mac(id, domain));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
};
export const eventOfIcsToken = (token: string) => eventOf(token, 'ics');

/** P-322: the e-mail's cover image. Same shape, `cover:` domain; resolves to the event's current cover, so no expiry is needed. */
export const coverUrlFor = (eventId: string) => `${env().apiOrigin}/v1/public/calendar/cover/${eventId}.${mac(eventId, 'cover')}`;
export const eventOfCoverToken = (token: string) => eventOf(token, 'cover');

/** Short signed URL (storage default, 1 h) of the 800 px WebP of the event's cover; null when the event is gone or has no cover. */
export async function coverRedirectOf(eventId: string): Promise<string | null> {
  const { db, calendarEvents: e, assets: a } = await dbm();
  const [r] = await db.select({ key: a.key }).from(e).innerJoin(a, eq(a.id, e.coverAssetId)).where(and(eq(e.id, eventId), isNull(e.deletedAt)));
  return r ? presignGet(`${r.key}/w800.webp`) : null;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** RFC 5545 3.1: 75 octets per line, continuation = CRLF + space. Never splits a UTF-8 character. */
const fold = (line: string) => {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  return [...out, cur].join('\r\n ');
};
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (d: string) => d.replaceAll('-', '');

export type IcsEvent = { id: string; title: string; location: string | null; description: string | null; allDay: boolean; startsAt: Date; endsAt: Date | null; date: string; updatedAt: Date };

export function buildIcs(e: IcsEvent): string {
  const next = new Date(Date.parse(`${e.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = e.endsAt ?? new Date(e.startsAt.getTime() + CALENDAR_LIMITS.defaultDurationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Remoa//Calendario//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${e.id}@remoa`, `DTSTAMP:${utc(e.updatedAt)}`,
    ...(e.allDay ? [`DTSTART;VALUE=DATE:${dateOnly(e.date)}`, `DTEND;VALUE=DATE:${dateOnly(next)}`] : [`DTSTART:${utc(e.startsAt)}`, `DTEND:${utc(end)}`]),
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const filenameOf = (title: string) => `${title.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'evento'}.ics`;

/** `userId` null = the public token route (server connection, the token is the credential). */
export async function icsOf(eventId: string, userId: string | null): Promise<Result<{ filename: string; body: string }>> {
  if (!idSchema.safeParse(eventId).success) return err('not_found', 'event not found');
  const s = await dbm();
  const { db, calendarEvents: e } = s;
  const [r] = await db.select({ e, date: localCols(s).date }).from(e).where(and(eq(e.id, eventId), isNull(e.deletedAt), userId ? eq(e.userId, userId) : undefined));
  if (!r) return err('not_found', 'event not found');
  return ok({ filename: filenameOf(r.e.title), body: buildIcs({ ...r.e, date: r.date }) });
}
