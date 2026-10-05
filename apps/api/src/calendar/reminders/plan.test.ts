import { describe, expect, it } from 'vitest';
import { eventForPlan, localOf, planReminders, zonedInstant, type PlanEvent } from './plan';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';
const LX = 'Europe/Lisbon';
const at = (iso: string) => new Date(iso);
const ev = (date: string, startTime: string | null, over: Partial<PlanEvent> = {}): PlanEvent => ({ date, startTime, remindD1: true, remindD0: true, ...over });
const sends = (p: ReturnType<typeof planReminders>) => Object.fromEntries(p.map((r) => [r.kind, `${r.sendAt.toISOString()} ${r.status}`]));

describe('zonedInstant (local wall time → instant)', () => {
  it('São Paulo is UTC-3 all year (no DST since 2019)', () => {
    expect(zonedInstant('2026-01-15', 7 * 60, SP).toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(zonedInstant('2026-07-15', 7 * 60, SP).toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });
  it('a time inside the spring-forward gap moves forward (02:30 → 03:30 EDT)', () => {
    expect(zonedInstant('2026-03-08', 150, NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('an ambiguous fall-back time takes the earlier instant (01:30 EDT)', () => {
    expect(zonedInstant('2026-11-01', 90, NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('round-trips with localOf', () => {
    expect(localOf(at('2026-03-29T05:30:00Z'), LX)).toEqual({ date: '2026-03-29', time: '06:30' });
  });
});

describe('planReminders (FR-13 / FR-14, Q-051)', () => {
  const early = at('2026-10-01T12:00:00Z');

  it('timed event: d1 18:00 the day before, d0 07:00 on the day, profile timezone', () => {
    expect(sends(planReminders(ev('2026-10-10', '14:00'), SP, early))).toEqual({
      d1: '2026-10-09T21:00:00.000Z scheduled',
      d0: '2026-10-10T10:00:00.000Z scheduled',
    });
  });

  it('occurrenceDate is the event local date', () => {
    expect(planReminders(ev('2026-10-10', '14:00'), SP, early).map((r) => r.occurrenceDate)).toEqual(['2026-10-10', '2026-10-10']);
  });

  it('created after 18:00 the day before: d1 skipped, d0 scheduled', () => {
    expect(sends(planReminders(ev('2026-10-10', '14:00'), SP, at('2026-10-09T22:00:00Z')))).toEqual({
      d1: '2026-10-09T21:00:00.000Z skipped',
      d0: '2026-10-10T10:00:00.000Z scheduled',
    });
  });

  it('created on the day after 07:00 but before the start: both skipped (still planned, never sent)', () => {
    expect(sends(planReminders(ev('2026-10-10', '14:00'), SP, at('2026-10-10T11:00:00Z')))).toEqual({
      d1: '2026-10-09T21:00:00.000Z skipped',
      d0: '2026-10-10T10:00:00.000Z skipped',
    });
  });

  it('send time exactly now counts as passed', () => {
    expect(sends(planReminders(ev('2026-10-10', '14:00'), SP, at('2026-10-10T10:00:00Z'))).d0).toBe('2026-10-10T10:00:00.000Z skipped');
  });

  it('an event that already started never gets reminders', () => {
    expect(planReminders(ev('2026-10-10', '14:00'), SP, at('2026-10-10T17:00:00Z'))).toEqual([]);
    expect(planReminders(ev('2026-10-01', '08:00'), SP, early)).toEqual([]);
  });

  it('starts before 08:00: d0 1 h before (07:30 → 06:30)', () => {
    expect(sends(planReminders(ev('2026-10-10', '07:30'), SP, early)).d0).toBe('2026-10-10T09:30:00.000Z scheduled');
  });

  it('never before 05:00 (05:30 → 05:00)', () => {
    expect(sends(planReminders(ev('2026-10-10', '05:30'), SP, early)).d0).toBe('2026-10-10T08:00:00.000Z scheduled');
  });

  it('starts at 08:00 exactly: the regular 07:00', () => {
    expect(sends(planReminders(ev('2026-10-10', '08:00'), SP, early)).d0).toBe('2026-10-10T10:00:00.000Z scheduled');
  });

  it('starts before 05:00: 05:00 would come after the start, so d0 is skipped (d1 still goes)', () => {
    expect(sends(planReminders(ev('2026-10-10', '04:00'), SP, early))).toEqual({
      d1: '2026-10-09T21:00:00.000Z scheduled',
      d0: '2026-10-10T08:00:00.000Z skipped',
    });
  });

  it('all-day: same hours; created that morning after 07:00 it is not "past" yet, both skipped', () => {
    expect(sends(planReminders(ev('2026-10-10', null), SP, early))).toEqual({
      d1: '2026-10-09T21:00:00.000Z scheduled',
      d0: '2026-10-10T10:00:00.000Z scheduled',
    });
    expect(sends(planReminders(ev('2026-10-10', null), SP, at('2026-10-10T15:00:00Z')))).toEqual({
      d1: '2026-10-09T21:00:00.000Z skipped',
      d0: '2026-10-10T10:00:00.000Z skipped',
    });
    expect(planReminders(ev('2026-10-10', null), SP, at('2026-10-11T03:00:00Z'))).toEqual([]); // local midnight passed
  });

  it('only the reminders that are on', () => {
    expect(planReminders(ev('2026-10-10', '14:00', { remindD1: false }), SP, early).map((r) => r.kind)).toEqual(['d0']);
    expect(planReminders(ev('2026-10-10', '14:00', { remindD1: false, remindD0: false }), SP, early)).toEqual([]);
  });

  it('New York, spring forward (Sun 2026-03-08): d1 in EST, d0 in EDT', () => {
    expect(sends(planReminders(ev('2026-03-08', '10:00'), NY, at('2026-03-01T00:00:00Z')))).toEqual({
      d1: '2026-03-07T23:00:00.000Z scheduled', // 18:00 EST
      d0: '2026-03-08T11:00:00.000Z scheduled', // 07:00 EDT
    });
    expect(sends(planReminders(ev('2026-03-09', '10:00'), NY, at('2026-03-01T00:00:00Z'))).d1).toBe('2026-03-08T22:00:00.000Z scheduled'); // 18:00 EDT
  });

  it('New York, fall back (Sun 2026-11-01): d1 in EDT, early d0 in EST', () => {
    expect(sends(planReminders(ev('2026-11-01', '06:30'), NY, at('2026-10-20T00:00:00Z')))).toEqual({
      d1: '2026-10-31T22:00:00.000Z scheduled', // 18:00 EDT
      d0: '2026-11-01T10:30:00.000Z scheduled', // 05:30 EST
    });
  });

  it('Lisbon, spring forward (Sun 2026-03-29): 07:30 → 06:30 WEST; d1 18:00 WET', () => {
    expect(sends(planReminders(ev('2026-03-29', '07:30'), LX, at('2026-03-20T00:00:00Z')))).toEqual({
      d1: '2026-03-28T18:00:00.000Z scheduled',
      d0: '2026-03-29T05:30:00.000Z scheduled',
    });
  });

  it('Lisbon, fall back (Sun 2026-10-25): d1 in WEST, d0 in WET', () => {
    expect(sends(planReminders(ev('2026-10-25', '10:00'), LX, early))).toEqual({
      d1: '2026-10-24T17:00:00.000Z scheduled',
      d0: '2026-10-25T07:00:00.000Z scheduled',
    });
  });
});

describe('eventForPlan (timezone change)', () => {
  const row = { startsAt: at('2026-10-10T17:00:00Z'), allDay: false, timezone: SP, remindD1: true, remindD0: true }; // 14:00 in São Paulo

  it('a timed event keeps its instant and is re-read in the new profile timezone', () => {
    expect(eventForPlan(row, SP)).toEqual(ev('2026-10-10', '14:00'));
    const lx = eventForPlan(row, LX); // 18:00 WEST
    expect(lx).toEqual(ev('2026-10-10', '18:00'));
    expect(sends(planReminders(lx, LX, at('2026-10-01T00:00:00Z')))).toEqual({
      d1: '2026-10-09T17:00:00.000Z scheduled', // 18:00 WEST
      d0: '2026-10-10T06:00:00.000Z scheduled', // 07:00 WEST
    });
  });

  it('a timed event can change date in the new timezone (Tokyo)', () => {
    expect(eventForPlan(row, 'Asia/Tokyo')).toEqual(ev('2026-10-11', '02:00'));
  });

  it('an all-day event keeps its date (from the event timezone) and gets the new timezone hours', () => {
    const allDay = { ...row, startsAt: at('2026-10-10T03:00:00Z'), allDay: true }; // local midnight in São Paulo
    expect(eventForPlan(allDay, 'Asia/Tokyo')).toEqual(ev('2026-10-10', null));
    expect(sends(planReminders(eventForPlan(allDay, 'Asia/Tokyo'), 'Asia/Tokyo', at('2026-10-01T00:00:00Z'))).d0).toBe('2026-10-09T22:00:00.000Z scheduled');
  });
});
