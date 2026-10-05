// G18 / F26 mocks for the web (bell, popover, /notificacoes, prefs) until the API lands. In-memory; resetNotificationMocks() between tests.
import { err, ok, parseWith } from '../errors';
import {
  NOTIFICATIONS_PAGE_SIZE, effectivePref, markReadInputSchema, notificationCategories, notificationListQuerySchema,
  notificationPrefKeys, notificationPrefsPatchSchema, reviewReminderHour, reviewReminderTimeOf,
  type Notification, type NotificationPrefKey, type NotificationPrefs,
} from '../notifications';
import type * as Api from '../api';
import { FIXTURE_NOW, fid } from './fixtures';

const at = (hours: number) => new Date(FIXTURE_NOW.getTime() + hours * 3_600_000);
const iso = (hours: number) => at(hours).toISOString();

/** sino-aberto.png: today, yesterday, this week, before; three unread. */
export const notificationFixtures: Notification[] = [
  { id: fid(8001), type: 'calendar_d1', category: 'calendar', href: `/app/calendario?evento=${fid(8101)}`, groupKey: null, createdAt: at(-1), readAt: null,
    data: { eventId: fid(8101), title: 'Prova de Clínica Médica', startsAt: iso(20), allDay: false, location: 'Sala 204 · Bloco B' } },
  { id: fid(8002), type: 'review_reminder', category: 'review', href: '/app/revisar', groupKey: null, createdAt: at(-3), readAt: null, data: { cards: 18 } },
  { id: fid(8003), type: 'map_ready', category: 'maps', href: `/app/mapas/${fid(8102)}`, groupKey: null, createdAt: at(-26), readAt: null,
    data: { boardId: fid(8102), title: 'Insuficiência cardíaca', cards: 24 } },
  { id: fid(8004), type: 'support_reply', category: 'support', href: `/app/suporte/${fid(8103)}`, groupKey: null, createdAt: at(-50), readAt: at(-49),
    data: { ticketId: fid(8103), ticketNumber: 1042 } },
  { id: fid(8005), type: 'referral_reward', category: 'referrals', href: '/app/indicar', groupKey: null, createdAt: at(-120), readAt: at(-100),
    data: { referralId: fid(8104), role: 'referrer' } },
  { id: fid(8006), type: 'purchase', category: 'account_billing', href: '/app/conta/plano', groupKey: null, createdAt: at(-240), readAt: at(-239),
    data: { planName: 'Remoa Pro', orderId: 'in_1Q2W3E' } },
];

let items: Notification[] = structuredClone(notificationFixtures);
let dismissed = new Set<string>();
let prefRows = new Map<NotificationPrefKey, { inApp: boolean; email: boolean }>();
let pause = false;
let hour = 20;
export function resetNotificationMocks(start: Notification[] = notificationFixtures) {
  items = structuredClone(start);
  dismissed = new Set();
  prefRows = new Map();
  pause = false;
  hour = 20;
}
/** Simulates notify() creating an in-app row (e.g. to test Realtime/badge in the web). */
export const pushNotificationMock = (n: Notification) => void items.unshift(structuredClone(n));

const visible = () => items.filter((n) => !dismissed.has(n.id));
const unread = () => visible().filter((n) => !n.readAt);

export const listNotifications: Api.ListNotifications = async (_userId, raw) => {
  const q = parseWith(notificationListQuerySchema, raw);
  if (!q.ok) return q;
  const all = visible()
    .filter((n) => (q.data.filter === 'unread' ? !n.readAt : true) && (!q.data.category || n.category === q.data.category))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const start = q.data.cursor ? Number(q.data.cursor) : 0;
  const page = all.slice(start, start + (q.data.limit ?? NOTIFICATIONS_PAGE_SIZE));
  const next = start + page.length;
  return ok({ items: structuredClone(page), nextCursor: next < all.length ? String(next) : null });
};

export const getUnreadCount: Api.GetUnreadCount = async () => {
  const u = unread();
  const byCategory = Object.fromEntries(notificationCategories.map((c) => [c, u.filter((n) => n.category === c).length])) as Record<(typeof notificationCategories)[number], number>;
  return ok({ total: u.length, byCategory });
};

export const markNotificationsRead: Api.MarkNotificationsRead = async (_userId, raw) => {
  const p = parseWith(markReadInputSchema, raw);
  if (!p.ok) return p;
  const ids = 'all' in p.data ? null : new Set(p.data.ids);
  let updated = 0;
  for (const n of visible()) if (!n.readAt && (!ids || ids.has(n.id))) { n.readAt = FIXTURE_NOW; updated++; }
  return ok({ updated, unread: unread().length });
};

export const dismissNotification: Api.DismissNotification = async (_userId, id) => {
  if (!visible().some((n) => n.id === id)) return err('not_found', 'notification not found');
  dismissed.add(id);
  return ok(null);
};

const prefs = (): NotificationPrefs => ({
  matrix: Object.fromEntries(notificationPrefKeys.map((k) => [k, effectivePref(k, prefRows.get(k) ?? null)])) as NotificationPrefs['matrix'],
  pauseReminders: pause,
  reviewReminderTime: reviewReminderTimeOf(hour),
});
export const getNotificationPrefs: Api.GetNotificationPrefs = async () => ok(prefs());
export const updateNotificationPrefs: Api.UpdateNotificationPrefs = async (_userId, raw) => {
  const p = parseWith(notificationPrefsPatchSchema, raw);
  if (!p.ok) return p;
  if (p.data.pref) {
    const { key, channel, value } = p.data.pref;
    prefRows.set(key, { ...effectivePref(key, prefRows.get(key) ?? null), [channel]: value });
  }
  if (p.data.pauseReminders !== undefined) pause = p.data.pauseReminders;
  if (p.data.reviewReminderTime) hour = reviewReminderHour(p.data.reviewReminderTime);
  return ok(prefs());
};

