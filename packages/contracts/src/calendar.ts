// G18 / F25 Calendário (feature file docs/features/F22-calendario.md). CCR-034, D-739–D-741.
// Routes (all requireUser, under /v1/calendar) are typed in api.ts. Instants on the wire are ISO strings (timestampSchema
// coerces them to Date); local fields (`date`, `startTime`, `endTime`) are in the event's `timezone` (= profile timezone at save).
import { z } from 'zod';
import { idSchema, timestampSchema } from './common';
import { CALENDAR_LIMITS, calendarColors } from './constants';

export { CALENDAR_LIMITS, CALENDAR_PALETTE, CALENDAR_REMINDER_RULES, calendarColors } from './constants'; // CCR-058: zod-free in ./constants

export const calendarColorSchema = z.enum(calendarColors);
export type CalendarColor = z.infer<typeof calendarColorSchema>;

/**
 * D-740: default labels are per-user rows seeded lazily (insert … on conflict do nothing on (user_id, system_key)) on the first
 * calendar read, so they can be renamed and recoloured. `personal` cannot be deleted: deleting any other label moves its events there.
 * The names are seed data (like seeded boards), shown as stored once the row exists.
 */
export const calendarSystemLabels = ['exam', 'assignment', 'important_date', 'shift', 'personal'] as const;
export type CalendarSystemLabel = (typeof calendarSystemLabels)[number];
export const DEFAULT_CALENDAR_LABELS: readonly { systemKey: CalendarSystemLabel; name: string; color: CalendarColor }[] = [
  { systemKey: 'exam', name: 'Prova', color: 'orange' },
  { systemKey: 'assignment', name: 'Trabalho', color: 'amber' },
  { systemKey: 'important_date', name: 'Data importante', color: 'purple' },
  { systemKey: 'shift', name: 'Plantão', color: 'teal' },
  { systemKey: 'personal', name: 'Pessoal', color: 'gray' },
];

export const calendarViews = ['month', 'week', 'agenda', 'gallery'] as const;
export const calendarViewSchema = z.enum(calendarViews);
export type CalendarView = z.infer<typeof calendarViewSchema>;

export const calendarReminderKinds = ['d1', 'd0'] as const;
export type CalendarReminderKind = (typeof calendarReminderKinds)[number];
export const calendarReminderStatuses = ['scheduled', 'sent', 'skipped', 'canceled'] as const;
export type CalendarReminderStatus = (typeof calendarReminderStatuses)[number];

const isValidDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDate, 'invalid date');
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Trimmed; empty string = null. */
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v ? v : null));

// --- labels ------------------------------------------------------------------
export const calendarLabelSchema = z.object({
  id: idSchema,
  name: z.string(),
  color: calendarColorSchema,
  systemKey: z.enum(calendarSystemLabels).nullable(),
  position: z.number().int(),
  /** user_preferences.calendar_hidden_labels (FR-9 visibility). */
  hidden: z.boolean(),
  /** Non-deleted events with this label. */
  eventCount: z.number().int().nonnegative(),
});
export type CalendarLabel = z.infer<typeof calendarLabelSchema>;

const labelName = z.string().trim().min(CALENDAR_LIMITS.labelNameMin).max(CALENDAR_LIMITS.labelNameMax);
/** POST /v1/calendar/labels — `conflict` 'label_limit' at CALENDAR_LIMITS.labels. */
export const calendarLabelInputSchema = z.object({ name: labelName, color: calendarColorSchema });
export type CalendarLabelInput = z.input<typeof calendarLabelInputSchema>;
/** PATCH /v1/calendar/labels/:id — any subset, at least one field. */
export const calendarLabelPatchSchema = z
  .object({ name: labelName, color: calendarColorSchema, hidden: z.boolean(), position: z.number().int().min(0).max(1000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'empty patch');
export type CalendarLabelPatch = z.input<typeof calendarLabelPatchSchema>;
/** DELETE /v1/calendar/labels/:id — events move to the `personal` label; deleting `personal` itself is `conflict` 'label_personal'. */
export const calendarLabelDeletedSchema = z.object({ movedTo: idSchema, moved: z.number().int().nonnegative() });
export type CalendarLabelDeleted = z.infer<typeof calendarLabelDeletedSchema>;
/** GET /v1/calendar/labels (seeds the defaults on first call). */
export const calendarLabelListSchema = z.object({ labels: z.array(calendarLabelSchema) });
export type CalendarLabelList = z.infer<typeof calendarLabelListSchema>;

// --- events ------------------------------------------------------------------
const eventFields = {
  title: z.string().trim().min(CALENDAR_LIMITS.titleMin).max(CALENDAR_LIMITS.titleMax),
  labelId: idSchema,
  date: localDateSchema,
  /** "Compromisso sem hora é dia inteiro": allDay ⇒ both times null; otherwise startTime is required. */
  allDay: z.boolean(),
  startTime: localTimeSchema.nullable(),
  /** Same day, >= startTime. null = no end (1 h on the grid). */
  endTime: localTimeSchema.nullable(),
  location: optionalText(CALENDAR_LIMITS.locationMax),
  description: optionalText(CALENDAR_LIMITS.descriptionMax),
  /** An own asset from POST /v1/uploads/sign {kind:'calendar_cover'} + /v1/uploads/complete. */
  coverAssetId: idSchema.nullable(),
  remindD1: z.boolean(),
  remindD0: z.boolean(),
};
type TimeFields = { allDay?: boolean; startTime?: string | null; endTime?: string | null };
/** Shared rule; the server runs it again on the merged row after a PATCH. */
export const eventTimeIssues = (v: TimeFields): { path: string; message: string }[] => {
  const out: { path: string; message: string }[] = [];
  if (v.allDay === true && (v.startTime || v.endTime)) out.push({ path: 'startTime', message: 'all-day events have no times' });
  if (v.allDay === false && v.startTime === null) out.push({ path: 'startTime', message: 'startTime required unless allDay' });
  if (v.endTime && v.startTime === null) out.push({ path: 'endTime', message: 'endTime needs startTime' });
  if (v.endTime && v.startTime && v.endTime < v.startTime) out.push({ path: 'endTime', message: 'endTime before startTime' });
  return out;
};
const timeRefine = (v: TimeFields, ctx: z.RefinementCtx) => {
  for (const i of eventTimeIssues(v)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
};

/** POST /v1/calendar/events. Defaults: timed event, no end, no place, no cover, both reminders on. */
export const calendarEventInputSchema = z
  .object({
    ...eventFields,
    allDay: eventFields.allDay.default(false),
    startTime: eventFields.startTime.default(null),
    endTime: eventFields.endTime.default(null),
    location: eventFields.location.default(null),
    description: eventFields.description.default(null),
    coverAssetId: eventFields.coverAssetId.default(null),
    remindD1: eventFields.remindD1.default(true),
    remindD0: eventFields.remindD0.default(true),
  })
  .superRefine(timeRefine);
export type CalendarEventInput = z.input<typeof calendarEventInputSchema>;
/** PATCH /v1/calendar/events/:id — any subset (at least one). Rules on fields present here; the server re-checks the merged event. */
export const calendarEventPatchSchema = z
  .object(eventFields)
  .partial()
  .superRefine(timeRefine)
  .refine((v) => Object.keys(v).length > 0, 'empty patch');
export type CalendarEventPatch = z.input<typeof calendarEventPatchSchema>;

/** One planned send (calendar_reminders row). Shown in the drawer with its time (FR-12). */
export const reminderPlanSchema = z.object({
  kind: z.enum(calendarReminderKinds),
  occurrenceDate: localDateSchema,
  sendAt: timestampSchema,
  status: z.enum(calendarReminderStatuses),
});
export type ReminderPlan = z.infer<typeof reminderPlanSchema>;

/** Signed GET URLs of the cover's WebP variants (R2 private). */
export const calendarCoverSchema = z.object({ assetId: idSchema, urls: z.object({ w800: z.string().url(), w1600: z.string().url() }) });
export type CalendarCover = z.infer<typeof calendarCoverSchema>;

export const calendarEventSchema = z.object({
  id: idSchema,
  title: z.string(),
  labelId: idSchema,
  date: localDateSchema,
  allDay: z.boolean(),
  startTime: localTimeSchema.nullable(),
  endTime: localTimeSchema.nullable(),
  /** Instant of `date startTime` (all-day: local midnight) in `timezone`. */
  startsAt: timestampSchema,
  endsAt: timestampSchema.nullable(),
  timezone: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  cover: calendarCoverSchema.nullable(),
  remindD1: z.boolean(),
  remindD0: z.boolean(),
  reminders: z.array(reminderPlanSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** GET /v1/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD — events whose local date is in [from, to] (inclusive, <= rangeMaxDays). */
export const calendarRangeQuerySchema = z
  .object({ from: localDateSchema, to: localDateSchema })
  .refine((v) => v.to >= v.from, { message: 'to before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < CALENDAR_LIMITS.rangeMaxDays, { message: 'range too long', path: ['to'] });
export type CalendarRangeQuery = z.infer<typeof calendarRangeQuerySchema>;
export const calendarEventListSchema = z.object({ events: z.array(calendarEventSchema) });
export type CalendarEventList = z.infer<typeof calendarEventListSchema>;

/** POST /v1/calendar/events/:id/duplicate — default +7 days, same time, reminders replanned. */
export const duplicateEventInputSchema = z.object({ days: z.number().int().min(1).max(365).default(CALENDAR_LIMITS.duplicateDays) });
export type DuplicateEventInput = z.input<typeof duplicateEventInputSchema>;
/** PATCH /v1/calendar/events/:id/reminders — turning one off cancels its scheduled send. */
export const eventRemindersInputSchema = z
  .object({ remindD1: z.boolean(), remindD0: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'empty patch');
export type EventRemindersInput = z.input<typeof eventRemindersInputSchema>;

/** Hoje (FR-17) and the rail dot (FR-1). `daysUntil` in the profile timezone: 0 today, 1 tomorrow. */
export const upcomingEventSchema = z.object({
  id: idSchema,
  title: z.string(),
  labelId: idSchema,
  labelName: z.string(),
  color: calendarColorSchema,
  date: localDateSchema,
  allDay: z.boolean(),
  startTime: localTimeSchema.nullable(),
  endTime: localTimeSchema.nullable(),
  startsAt: timestampSchema,
  location: z.string().nullable(),
  daysUntil: z.number().int().nonnegative(),
});
export type UpcomingEvent = z.infer<typeof upcomingEventSchema>;
/** GET /v1/calendar/upcoming?limit= — from now on, hidden labels included (Hoje shows everything). */
export const upcomingQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(CALENDAR_LIMITS.upcomingMax).default(CALENDAR_LIMITS.upcomingDefault) });
export const upcomingEventsSchema = z.object({
  events: z.array(upcomingEventSchema),
  /** Something starts in the next 24 h: pulsing dot on the rail, amber strip on Hoje. */
  within24h: z.boolean(),
});
export type UpcomingEvents = z.infer<typeof upcomingEventsSchema>;

/** GET /v1/calendar/settings. `view` null = never chosen (client default: month on desktop, agenda on mobile). */
export const calendarSettingsSchema = z.object({
  view: calendarViewSchema.nullable(),
  tourSeenAt: timestampSchema.nullable(),
  timezone: z.string(),
  hiddenLabelIds: z.array(idSchema),
});
export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;
/** PATCH /v1/calendar/view */
export const calendarViewInputSchema = z.object({ view: calendarViewSchema });
export type CalendarViewInput = z.infer<typeof calendarViewInputSchema>;
/** POST /v1/calendar/tour-seen (idempotent: keeps the first timestamp). */
export const calendarTourSeenSchema = z.object({ tourSeenAt: timestampSchema });
export type CalendarTourSeen = z.infer<typeof calendarTourSeenSchema>;

export const calendarErrors = {
  labelLimit: 'label_limit',
  labelPersonal: 'label_personal',
  badCover: 'calendar_bad_cover',
  badLabel: 'calendar_bad_label',
} as const;
