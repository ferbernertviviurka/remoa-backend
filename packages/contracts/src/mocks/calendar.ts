// G18 / F25 calendar mocks for the web until the API lands. In-memory; resetCalendarMocks() between tests.
// ponytail: fixed America/Sao_Paulo (-03:00, no DST since 2019); reminders are a simple plan, not the real planner.
import { err, ok, parseWith } from '../errors';
import {
  CALENDAR_LIMITS, CALENDAR_REMINDER_RULES, DEFAULT_CALENDAR_LABELS, calendarEventInputSchema, calendarEventPatchSchema, calendarLabelInputSchema,
  calendarLabelPatchSchema, calendarRangeQuerySchema, calendarViewInputSchema, duplicateEventInputSchema, eventRemindersInputSchema, eventTimeIssues,
  type CalendarEvent, type CalendarLabel, type CalendarView, type ReminderPlan,
} from '../calendar';
import type * as Api from '../api';
import { FIXTURE_NOW, fid } from './fixtures';

const TZ = 'America/Sao_Paulo';
const instant = (date: string, time: string | null) => new Date(`${date}T${time ?? '00:00'}:00-03:00`);
const localDate = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const today = localDate(FIXTURE_NOW);

export const calendarLabelFixtures: CalendarLabel[] = DEFAULT_CALENDAR_LABELS.map((l, i) => ({ id: fid(9001 + i), ...l, position: i, hidden: false, eventCount: 0 }));
const labelId = (k: string) => calendarLabelFixtures.find((l) => l.systemKey === k)!.id;

const plan = (e: Pick<CalendarEvent, 'date' | 'startTime' | 'remindD1' | 'remindD0'>, now: Date): ReminderPlan[] => {
  const r = CALENDAR_REMINDER_RULES;
  const out: ReminderPlan[] = [];
  const status = (at: Date) => (at <= now ? 'skipped' : 'scheduled') as ReminderPlan['status'];
  if (e.remindD1) {
    const at = instant(addDays(e.date, -1), `${String(r.d1Hour).padStart(2, '0')}:00`);
    out.push({ kind: 'd1', occurrenceDate: e.date, sendAt: at, status: status(at) });
  }
  if (e.remindD0) {
    const start = instant(e.date, e.startTime);
    const early = e.startTime !== null && Number(e.startTime.slice(0, 2)) < r.earlyStartBeforeHour;
    const floor = instant(e.date, `0${r.notBeforeHour}:00`);
    let at = early ? new Date(start.getTime() - r.earlyLeadMinutes * 60_000) : instant(e.date, `0${r.d0Hour}:00`);
    if (at < floor) at = floor;
    out.push({ kind: 'd0', occurrenceDate: e.date, sendAt: at, status: status(at) });
  }
  return out;
};

type Fields = Pick<CalendarEvent, 'title' | 'labelId' | 'date' | 'allDay' | 'startTime' | 'endTime' | 'location' | 'description' | 'remindD1' | 'remindD0'> & { coverAssetId: string | null };
const build = (id: string, f: Fields, createdAt: Date): CalendarEvent => ({
  id, title: f.title, labelId: f.labelId, date: f.date, allDay: f.allDay, startTime: f.startTime, endTime: f.endTime,
  startsAt: instant(f.date, f.allDay ? null : f.startTime), endsAt: f.endTime ? instant(f.date, f.endTime) : null, timezone: TZ,
  location: f.location, description: f.description,
  cover: f.coverAssetId ? { assetId: f.coverAssetId, urls: { w800: `https://storage.remoa.mock/${f.coverAssetId}/w800.webp`, w1600: `https://storage.remoa.mock/${f.coverAssetId}/w1600.webp` } } : null,
  remindD1: f.remindD1, remindD0: f.remindD0, reminders: plan(f, FIXTURE_NOW), createdAt, updatedAt: createdAt,
});
const fields = (e: CalendarEvent): Fields => ({ ...e, coverAssetId: e.cover?.assetId ?? null });

/** calendario-mes.png: the five design examples, relative to FIXTURE_NOW. */
export const calendarEventFixtures: CalendarEvent[] = [
  build(fid(9101), { title: 'Grupo de estudo', labelId: labelId('personal'), date: today, allDay: false, startTime: '19:00', endTime: '21:00', location: 'Biblioteca central', description: 'Revisão de casos clínicos com a turma.', remindD1: true, remindD0: true, coverAssetId: null }, FIXTURE_NOW),
  build(fid(9102), { title: 'Prova de Clínica Médica', labelId: labelId('exam'), date: addDays(today, 1), allDay: false, startTime: '08:00', endTime: '10:00', location: 'Sala 204 · Bloco B', description: 'Capítulos 1 a 6: sepse, insuficiência cardíaca e pneumonia. Levar documento com foto.', remindD1: true, remindD0: true, coverAssetId: fid(9201) }, FIXTURE_NOW),
  build(fid(9103), { title: 'Entrega do trabalho de Epidemiologia', labelId: labelId('assignment'), date: addDays(today, 3), allDay: false, startTime: '23:59', endTime: null, location: 'Plataforma da faculdade', description: 'Enviar o PDF com as referências em ABNT.', remindD1: true, remindD0: true, coverAssetId: null }, FIXTURE_NOW),
  build(fid(9104), { title: 'Prazo da inscrição da residência', labelId: labelId('important_date'), date: addDays(today, 5), allDay: true, startTime: null, endTime: null, location: 'Site da banca', description: 'Conferir documentos e pagar a taxa antes do prazo.', remindD1: true, remindD0: true, coverAssetId: null }, FIXTURE_NOW),
  build(fid(9105), { title: 'Plantão no pronto-socorro', labelId: labelId('shift'), date: addDays(today, 6), allDay: false, startTime: '19:00', endTime: '23:00', location: 'Hospital universitário', description: null, remindD1: true, remindD0: true, coverAssetId: null }, FIXTURE_NOW),
];

let events: CalendarEvent[] = [];
let deleted = new Set<string>();
let labels: CalendarLabel[] = [];
let view: CalendarView | null = null;
let tourSeenAt: Date | null = null;
let seq = 0;
export function resetCalendarMocks(o: { events?: CalendarEvent[]; tourSeen?: boolean } = {}) {
  events = structuredClone(o.events ?? calendarEventFixtures);
  deleted = new Set();
  labels = structuredClone(calendarLabelFixtures);
  view = null;
  tourSeenAt = o.tourSeen ? FIXTURE_NOW : null;
  seq = 0;
}
resetCalendarMocks();

const live = () => events.filter((e) => !deleted.has(e.id));
const own = (id: string) => live().find((e) => e.id === id);
const withCount = (l: CalendarLabel): CalendarLabel => ({ ...l, eventCount: live().filter((e) => e.labelId === l.id).length });

export const listCalendarEvents: Api.ListCalendarEvents = async (_u, raw) => {
  const q = parseWith(calendarRangeQuerySchema, raw);
  if (!q.ok) return q;
  return ok({ events: structuredClone(live().filter((e) => e.date >= q.data.from && e.date <= q.data.to).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) });
};
export const createCalendarEvent: Api.CreateCalendarEvent = async (_u, raw) => {
  const p = parseWith(calendarEventInputSchema, raw);
  if (!p.ok) return p;
  if (!labels.some((l) => l.id === p.data.labelId)) return err('validation', 'calendar_bad_label');
  const e = build(fid(9300 + seq++), p.data, FIXTURE_NOW);
  events.push(e);
  return ok(structuredClone(e));
};
export const updateCalendarEvent: Api.UpdateCalendarEvent = async (_u, id, raw) => {
  const p = parseWith(calendarEventPatchSchema, raw);
  if (!p.ok) return p;
  const cur = own(id);
  if (!cur) return err('not_found', 'event not found');
  const merged = { ...fields(cur), ...p.data };
  const issues = eventTimeIssues(merged);
  if (issues.length) return err('validation', issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  const next = { ...build(id, merged, cur.createdAt), updatedAt: FIXTURE_NOW };
  events = events.map((e) => (e.id === id ? next : e));
  return ok(structuredClone(next));
};
export const deleteCalendarEvent: Api.DeleteCalendarEvent = async (_u, id) => {
  if (!own(id)) return err('not_found', 'event not found');
  deleted.add(id);
  return ok(null);
};
export const duplicateCalendarEvent: Api.DuplicateCalendarEvent = async (_u, id, raw) => {
  const p = parseWith(duplicateEventInputSchema, raw);
  if (!p.ok) return p;
  const cur = own(id);
  if (!cur) return err('not_found', 'event not found');
  const e = build(fid(9300 + seq++), { ...fields(cur), date: addDays(cur.date, p.data.days) }, FIXTURE_NOW);
  events.push(e);
  return ok(structuredClone(e));
};
export const setCalendarReminders: Api.SetCalendarReminders = async (u, id, raw) => {
  const p = parseWith(eventRemindersInputSchema, raw);
  if (!p.ok) return p;
  return updateCalendarEvent(u, id, p.data);
};
export const getUpcomingEvents: Api.GetUpcomingEvents = async (_u, limit, now) => {
  const next = live().filter((e) => (e.endsAt ?? new Date(e.startsAt.getTime() + CALENDAR_LIMITS.defaultDurationMinutes * 60_000)) > now || (e.allDay && e.date >= localDate(now)))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const day = Date.parse(`${localDate(now)}T00:00:00Z`);
  return ok({
    events: next.slice(0, limit).map((e) => {
      const l = labels.find((x) => x.id === e.labelId)!;
      return { id: e.id, title: e.title, labelId: l.id, labelName: l.name, color: l.color, date: e.date, allDay: e.allDay, startTime: e.startTime, endTime: e.endTime, startsAt: e.startsAt, location: e.location, daysUntil: Math.round((Date.parse(`${e.date}T00:00:00Z`) - day) / 86_400_000) };
    }),
    within24h: next.some((e) => e.startsAt.getTime() - now.getTime() <= 86_400_000),
  });
};
export const listCalendarLabels: Api.ListCalendarLabels = async () => ok({ labels: labels.map(withCount) });
export const createCalendarLabel: Api.CreateCalendarLabel = async (_u, raw) => {
  const p = parseWith(calendarLabelInputSchema, raw);
  if (!p.ok) return p;
  if (labels.length >= CALENDAR_LIMITS.labels) return err('conflict', 'label_limit');
  const l: CalendarLabel = { id: fid(9400 + seq++), ...p.data, systemKey: null, position: labels.length, hidden: false, eventCount: 0 };
  labels.push(l);
  return ok(structuredClone(l));
};
export const updateCalendarLabel: Api.UpdateCalendarLabel = async (_u, id, raw) => {
  const p = parseWith(calendarLabelPatchSchema, raw);
  if (!p.ok) return p;
  const l = labels.find((x) => x.id === id);
  if (!l) return err('not_found', 'label not found');
  Object.assign(l, p.data);
  return ok(withCount(l));
};
export const deleteCalendarLabel: Api.DeleteCalendarLabel = async (_u, id) => {
  const l = labels.find((x) => x.id === id);
  if (!l) return err('not_found', 'label not found');
  if (l.systemKey === 'personal') return err('conflict', 'label_personal');
  const personal = labels.find((x) => x.systemKey === 'personal')!;
  let moved = 0;
  for (const e of events) if (e.labelId === id) { e.labelId = personal.id; moved++; }
  labels = labels.filter((x) => x.id !== id);
  return ok({ movedTo: personal.id, moved });
};
export const getCalendarSettings: Api.GetCalendarSettings = async () => ok({ view, tourSeenAt, timezone: TZ, hiddenLabelIds: labels.filter((l) => l.hidden).map((l) => l.id) });
export const markCalendarTourSeen: Api.MarkCalendarTourSeen = async () => {
  tourSeenAt ??= FIXTURE_NOW;
  return ok({ tourSeenAt });
};
export const setCalendarView: Api.SetCalendarView = async (_u, raw) => {
  const p = parseWith(calendarViewInputSchema, raw);
  if (!p.ok) return p;
  view = p.data.view;
  return ok({ view });
};
