// G18 (CCR-034): e-mails, notifications and calendar contracts.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADDRESS_NOTICES, CALENDAR_PALETTE, EMAIL_CLASS, EMAIL_VERSIONS, emailTemplates, NOTIFICATION_PREFS, NOTIFICATION_TYPES, calendarEventInputSchema, calendarEventPatchSchema, calendarLabelPatchSchema,
  calendarRangeQuerySchema, effectivePref, emailDataSchemas, markReadInputSchema, notificationPrefKey, notificationPrefsPatchSchema, notificationSchema,
  notificationTypes, reviewReminderHour, reviewReminderTimeOf, uploadSignInputSchema,
} from './index';
import {
  FIXTURE_NOW, calendarEventFixtures, createCalendarEvent, deleteCalendarLabel, emailExamples, getNotificationPrefs, getUnreadCount, getUpcomingEvents,
  listCalendarLabels, markNotificationsRead, notificationFixtures, resetCalendarMocks, resetNotificationMocks, updateCalendarEvent, updateNotificationPrefs,
} from './mocks';

const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe('calendar', () => {
  const base = { title: 'Prova de Clínica', labelId: '00000000-0000-4000-8000-000000009001', date: '2026-10-06', startTime: '08:00' };
  it('input defaults: timed, both reminders on, empty text = null', () => {
    expect(calendarEventInputSchema.parse({ ...base, location: '  ' })).toMatchObject({ allDay: false, endTime: null, location: null, remindD1: true, remindD0: true, coverAssetId: null });
  });
  it.each([
    [{ title: 'P' }, 'title'],
    [{ title: 'x'.repeat(121) }, 'title'],
    [{ location: 'x'.repeat(161) }, 'location'],
    [{ description: 'x'.repeat(2001) }, 'description'],
    [{ endTime: '07:59' }, 'endTime'],
    [{ startTime: null }, 'startTime'],
    [{ allDay: true }, 'startTime'],
    [{ date: '2026-02-30' }, 'date'],
  ])('rejects %j', (patch, path) => {
    const r = calendarEventInputSchema.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(path);
  });
  it('end equal to start and all-day without times are fine', () => {
    expect(calendarEventInputSchema.safeParse({ ...base, endTime: '08:00' }).success).toBe(true);
    expect(calendarEventInputSchema.safeParse({ ...base, startTime: null, allDay: true }).success).toBe(true);
  });
  it('patch: partial, not empty; pairwise rule only on present fields', () => {
    expect(calendarEventPatchSchema.safeParse({}).success).toBe(false);
    expect(calendarEventPatchSchema.safeParse({ endTime: '09:00' }).success).toBe(true);
    expect(calendarEventPatchSchema.safeParse({ startTime: '10:00', endTime: '09:00' }).success).toBe(false);
    expect(calendarLabelPatchSchema.safeParse({}).success).toBe(false);
  });
  it('range: ordered and at most 100 days', () => {
    expect(calendarRangeQuerySchema.safeParse({ from: '2026-09-01', to: '2026-11-30' }).success).toBe(true);
    expect(calendarRangeQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
    expect(calendarRangeQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(false);
  });
  it('palette text passes 4.5:1 on its background, on white and on the canvas', () => {
    for (const c of Object.values(CALENDAR_PALETTE)) for (const bg of [c.bg, '#FFFFFF', '#F6F5FB']) expect(contrast(c.text, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it('cover upload: png/jpeg up to 5 MB', () => {
    expect(uploadSignInputSchema.safeParse({ kind: 'calendar_cover', mime: 'image/png', sizeBytes: 5 * 1024 * 1024 }).success).toBe(true);
    expect(uploadSignInputSchema.safeParse({ kind: 'calendar_cover', mime: 'image/png', sizeBytes: 5 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(uploadSignInputSchema.safeParse({ kind: 'calendar_cover', mime: 'image/webp', sizeBytes: 10 }).success).toBe(false);
  });
});

describe('notifications', () => {
  it('type table agrees with the preference rows', () => {
    for (const t of notificationTypes) {
      const d = NOTIFICATION_TYPES[t];
      const key = notificationPrefKey(t, { window: 'd0' });
      expect(NOTIFICATION_PREFS[key].category).toBe(d.category);
      if (d.inApp) expect(NOTIFICATION_PREFS[key].inApp).not.toBe('none');
      // only reminder-class templates are capped and pausable
      const reminder = d.email !== null && EMAIL_CLASS[d.email] === 'reminder';
      expect(d.capRank !== null).toBe(reminder);
      if (reminder) expect(NOTIFICATION_PREFS[key].pausable).toBe(true);
    }
    expect(notificationPrefKey('calendar_digest', { window: 'd1' })).toBe('calendar_d1');
  });
  it('D-760: every user type and every address notice has a template', () => {
    for (const t of notificationTypes) expect(NOTIFICATION_TYPES[t].email, t).not.toBeNull();
    expect(Object.values(ADDRESS_NOTICES).map((a) => EMAIL_CLASS[a.email])).toEqual(['list', 'list', 'transactional', 'transactional']); // CCR-037: auth e-mails by address
  });
  it('effective prefs: defaults, stored rows, fixed and absent channels', () => {
    expect(effectivePref('review_reminder', null)).toEqual({ inApp: true, email: false });
    expect(effectivePref('review_reminder', { inApp: false, email: true })).toEqual({ inApp: false, email: true });
    expect(effectivePref('support', { inApp: true, email: false })).toEqual({ inApp: true, email: true });
    expect(effectivePref('inactivity', { inApp: true, email: true })).toEqual({ inApp: false, email: true });
  });
  it('prefs patch refuses fixed / absent channels and empty bodies', () => {
    expect(notificationPrefsPatchSchema.safeParse({ pref: { key: 'support', channel: 'email', value: false } }).success).toBe(false);
    expect(notificationPrefsPatchSchema.safeParse({ pref: { key: 'inactivity', channel: 'inApp', value: true } }).success).toBe(false);
    expect(notificationPrefsPatchSchema.safeParse({}).success).toBe(false);
    expect(notificationPrefsPatchSchema.safeParse({ reviewReminderTime: '19:00' }).success).toBe(false);
    expect(notificationPrefsPatchSchema.safeParse({ pref: { key: 'support', channel: 'inApp', value: false }, pauseReminders: true }).success).toBe(true);
  });
  it('mark read: ids or all, not both', () => {
    expect(markReadInputSchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markReadInputSchema.safeParse({ all: true, ids: [FIXTURE_NOW] }).success).toBe(false);
  });
  it('review reminder time <-> reminder_hour', () => {
    expect(reviewReminderHour('07:00')).toBe(7);
    expect(reviewReminderTimeOf(12)).toBe('12:00');
    expect(reviewReminderTimeOf(19)).toBe('20:00');
  });
  it('fixtures parse; email-only types have no in-app variant', () => {
    for (const n of notificationFixtures) expect(notificationSchema.parse(n)).toEqual(n);
    expect(notificationSchema.safeParse({ ...notificationFixtures[0], type: 'inactivity', data: {} }).success).toBe(false);
  });
});

describe('emails', () => {
  it('every example matches its data schema, and every template/version has one', () => {
    expect(emailExamples).toHaveLength(29); // 11 HTML references + the account-confirm email_change title variant + 14 (CCR-035) + magiclink (CCR-037) + trial-ending d3/d0 (D-1213)
    for (const t of emailTemplates) {
      const versions: readonly string[] = (EMAIL_VERSIONS as Partial<Record<string, readonly string[]>>)[t] ?? ['default'];
      for (const v of versions) expect(emailExamples.some((e) => e.template === t && e.version === v), `${t}/${v}`).toBe(true);
    }
    for (const e of emailExamples) expect(emailDataSchemas[e.template].safeParse(e.data).error?.issues ?? []).toEqual([]);
  });
});

describe('mocks', () => {
  beforeEach(() => {
    resetNotificationMocks();
    resetCalendarMocks();
  });
  it('notifications: unread counts, mark all, prefs', async () => {
    const u = await getUnreadCount('u');
    expect(u.ok && u.data.total).toBe(3);
    const r = await markNotificationsRead('u', { all: true });
    expect(r.ok && r.data).toEqual({ updated: 3, unread: 0 });
    const p = await updateNotificationPrefs('u', { pref: { key: 'review_reminder', channel: 'email', value: true }, reviewReminderTime: '07:00' });
    expect(p.ok && p.data.matrix.review_reminder).toEqual({ inApp: true, email: true });
    const g = await getNotificationPrefs('u');
    expect(g.ok && g.data.reviewReminderTime).toBe('07:00');
  });
  it('calendar: create, merged patch validation, upcoming, label delete moves events', async () => {
    const labels = await listCalendarLabels('u');
    const exam = labels.ok ? labels.data.labels.find((l) => l.systemKey === 'exam')! : null;
    const c = await createCalendarEvent('u', { title: 'Simulado', labelId: exam!.id, date: '2026-10-10', startTime: '07:00' });
    expect(c.ok && c.data.reminders.map((r) => [r.kind, r.sendAt.toISOString()])).toEqual([['d1', '2026-10-09T21:00:00.000Z'], ['d0', '2026-10-10T09:00:00.000Z']]);
    const bad = await updateCalendarEvent('u', c.ok ? c.data.id : '', { endTime: '06:00' });
    expect(bad.ok).toBe(false);
    const up = await getUpcomingEvents('u', 4, FIXTURE_NOW);
    expect(up.ok && up.data.events).toHaveLength(4);
    expect(up.ok && up.data.within24h).toBe(true);
    const d = await deleteCalendarLabel('u', exam!.id);
    expect(d.ok && d.data.moved).toBe(2);
    expect(calendarEventFixtures).toHaveLength(5);
  });
});
