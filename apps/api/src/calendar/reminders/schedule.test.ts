// Integration: needs local Supabase (`pnpm db:up && pnpm db:migrate`, DATABASE_URL from the repo-root .env); skipped otherwise.
// Dates are in 2020 on purpose: the dispatcher works on every user's due rows, and a 2020 clock only touches rows made here.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notify } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('calendar reminders: schedule + dispatch (F25 FR-13/14/15)', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let schedule: typeof import('./schedule');
  let dispatch: typeof import('./dispatch');

  const newUser = async (tz = 'America/Sao_Paulo') => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    await dbm.db.execute(sql`update profiles set timezone = ${tz}, name = 'Ana Souza' where user_id = ${id}`);
    const [l] = await dbm.db.execute<{ id: string }>(sql`insert into calendar_labels (user_id, name, color) values (${id}, 'Prova', 'orange') returning id`);
    return { id, label: l!.id };
  };
  /** `startsAt` is the instant; all-day = local midnight in São Paulo. */
  const newEvent = async (u: { id: string; label: string }, startsAt: string, o: { allDay?: boolean; title?: string } = {}) => {
    const [e] = await dbm.db.execute<{ id: string }>(sql`
      insert into calendar_events (user_id, title, label_id, starts_at, all_day, timezone)
      values (${u.id}, ${o.title ?? 'Prova de Clínica'}, ${u.label}, ${startsAt}::timestamptz, ${o.allDay ?? false}, 'America/Sao_Paulo') returning id`);
    return e!.id;
  };
  const rows = async (eventId: string) =>
    (await dbm.db.execute<{ kind: string; occurrence_date: string; send_at: Date; status: string }>(sql`
      select kind, occurrence_date::text, send_at, status from calendar_reminders where event_id = ${eventId} order by occurrence_date, kind::text`))
      .map((r) => `${r.kind} ${r.occurrence_date} ${new Date(r.send_at).toISOString()} ${r.status}`);
  // what the calendar routes do: replan inside the user's own (RLS) transaction
  const replan = (userId: string, eventId: string, now: Date) => dbm.withUser(userId, (tx) => schedule.replanEventReminders(tx, eventId, now));

  const calls: { userId: string; type: string; payload: Record<string, unknown> }[] = [];
  const fake = (delayMs = 0): Notify => async (userId, type, payload) => {
    calls.push({ userId, type, payload: payload as Record<string, unknown> });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { inApp: 'created', notificationId: null, email: 'queued', emailDeliveryId: null };
  };
  const mine = (userId: string) => calls.filter((c) => c.userId === userId);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    schedule = await import('./schedule');
    dispatch = await import('./dispatch');
  });
  afterAll(async () => {
    if (users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`);
  });

  const early = new Date('2020-03-01T12:00:00Z');

  it('plans d1/d0 in the profile timezone, idempotently, from a user (RLS) transaction, and restores the role', async () => {
    const u = await newUser();
    const ev = await newEvent(u, '2020-03-10T17:00:00Z'); // 14:00 São Paulo
    await replan(u.id, ev, early);
    await replan(u.id, ev, early);
    expect(await rows(ev)).toEqual(['d0 2020-03-10 2020-03-10T10:00:00.000Z scheduled', 'd1 2020-03-10 2020-03-09T21:00:00.000Z scheduled']);
    const role = await dbm.withUser(u.id, async (tx) => {
      await schedule.replanEventReminders(tx, ev, early);
      const [r] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      return r!.role;
    });
    expect(role).toBe('authenticated');
    await expect(dbm.withUser(u.id, (tx) => tx.execute(sql`update calendar_reminders set status = 'sent' where event_id = ${ev}`))).rejects.toThrow();
  });

  it('created late: d1 skipped; editing reschedules; a sent reminder never changes; switching off cancels; deleting cancels', async () => {
    const u = await newUser();
    const ev = await newEvent(u, '2020-03-10T17:00:00Z');
    await replan(u.id, ev, new Date('2020-03-09T22:00:00Z')); // 19:00 the day before
    expect(await rows(ev)).toEqual(['d0 2020-03-10 2020-03-10T10:00:00.000Z scheduled', 'd1 2020-03-10 2020-03-09T21:00:00.000Z skipped']);

    // move to the next day: the old date's scheduled row is canceled, the new date is planned
    await dbm.db.execute(sql`update calendar_events set starts_at = '2020-03-11T17:00:00Z' where id = ${ev}`);
    await replan(u.id, ev, early);
    expect(await rows(ev)).toEqual([
      'd0 2020-03-10 2020-03-10T10:00:00.000Z canceled',
      'd1 2020-03-10 2020-03-09T21:00:00.000Z skipped',
      'd0 2020-03-11 2020-03-11T10:00:00.000Z scheduled',
      'd1 2020-03-11 2020-03-10T21:00:00.000Z scheduled',
    ]);

    // d1 went out; then the time moves to 07:30 the same day: d1 stays sent, d0 moves to 06:30
    await dbm.db.execute(sql`update calendar_reminders set status = 'sent' where event_id = ${ev} and kind = 'd1' and occurrence_date = '2020-03-11'`);
    await dbm.db.execute(sql`update calendar_events set starts_at = '2020-03-11T10:30:00Z' where id = ${ev}`);
    await replan(u.id, ev, early);
    expect((await rows(ev)).slice(2)).toEqual(['d0 2020-03-11 2020-03-11T09:30:00.000Z scheduled', 'd1 2020-03-11 2020-03-10T21:00:00.000Z sent']);

    await dbm.db.execute(sql`update calendar_events set remind_d0 = false where id = ${ev}`);
    await replan(u.id, ev, early);
    expect((await rows(ev))[2]).toBe('d0 2020-03-11 2020-03-11T09:30:00.000Z canceled');
    await dbm.db.execute(sql`update calendar_events set remind_d0 = true where id = ${ev}`);
    await replan(u.id, ev, early);
    expect((await rows(ev))[2]).toBe('d0 2020-03-11 2020-03-11T09:30:00.000Z scheduled');

    await dbm.db.execute(sql`update calendar_events set deleted_at = now() where id = ${ev}`);
    await replan(u.id, ev, early);
    expect((await rows(ev)).slice(2)).toEqual(['d0 2020-03-11 2020-03-11T09:30:00.000Z canceled', 'd1 2020-03-11 2020-03-10T21:00:00.000Z sent']);
  });

  it('a profile timezone change replans the pending reminders', async () => {
    const u = await newUser();
    const ev = await newEvent(u, '2020-03-10T17:00:00Z');
    await replan(u.id, ev, early);
    await dbm.db.execute(sql`update profiles set timezone = 'Europe/Lisbon' where user_id = ${u.id}`);
    expect(await dbm.db.transaction((tx) => schedule.replanUserReminders(tx, u.id, early))).toBe(2);
    expect(await rows(ev)).toEqual(['d0 2020-03-10 2020-03-10T07:00:00.000Z scheduled', 'd1 2020-03-10 2020-03-09T18:00:00.000Z scheduled']);
  });

  it('dispatch: one notify per (user, kind, day): a single event → calendar_d1, three → one calendar_digest; never twice', async () => {
    const solo = await newUser();
    const one = await newEvent(solo, '2020-03-10T17:00:00Z', { title: 'Plantão' });
    const busy = await newUser();
    const evs = [await newEvent(busy, '2020-03-10T11:00:00Z'), await newEvent(busy, '2020-03-10T17:00:00Z'), await newEvent(busy, '2020-03-10T03:00:00Z', { allDay: true })];
    const later = await newEvent(busy, '2020-03-12T17:00:00Z'); // other day: not in this run
    for (const e of evs) await replan(busy.id, e, early);
    await replan(busy.id, later, early);
    await replan(solo.id, one, early);

    const at = new Date('2020-03-09T21:01:00Z'); // 18:01 the day before, São Paulo
    await Promise.all([dispatch.dispatchDueReminders(at, fake(150)), dispatch.dispatchDueReminders(at, fake(150))]); // two concurrent runs
    await dispatch.dispatchDueReminders(at, fake());

    expect(mine(solo.id)).toHaveLength(1);
    expect(mine(solo.id)[0]).toMatchObject({ type: 'calendar_d1', payload: { data: { eventId: one, title: 'Plantão' }, email: { version: 'd1', title: 'Plantão', labelName: 'Prova', timezone: 'America/Sao_Paulo' } } });
    expect(mine(busy.id)).toHaveLength(1);
    const digest = mine(busy.id)[0]!;
    expect(digest).toMatchObject({ type: 'calendar_digest', payload: { data: { window: 'd1', date: '2020-03-10', count: 3 }, email: { version: 'varios', window: 'd1', name: 'Ana', date: '2020-03-10' } } });
    expect(new Set((digest.payload.data as { eventIds: string[] }).eventIds)).toEqual(new Set(evs));
    for (const e of evs) expect((await rows(e)).find((r) => r.startsWith('d1'))).toMatch(/ sent$/);
    expect((await rows(later)).every((r) => r.endsWith('scheduled'))).toBe(true);

    // editing a sent event's time does not resend
    await dbm.db.execute(sql`update calendar_events set starts_at = '2020-03-10T18:00:00Z' where id = ${one}`);
    await replan(solo.id, one, at);
    await dispatch.dispatchDueReminders(new Date('2020-03-09T21:30:00Z'), fake());
    expect(mine(solo.id)).toHaveLength(1);
  });

  it('dispatch: more than 3 h late is skipped, a deleted event is canceled, a started event is skipped', async () => {
    const u = await newUser();
    const late = await newEvent(u, '2020-04-10T17:00:00Z');
    const gone = await newEvent(u, '2020-04-11T17:00:00Z');
    await replan(u.id, late, early);
    await replan(u.id, gone, early);
    await dbm.db.execute(sql`update calendar_events set deleted_at = now() where id = ${gone}`); // no replan: the safety net catches it
    await dispatch.dispatchDueReminders(new Date('2020-04-10T01:00:00Z'), fake()); // d1 of `late` was 21:00Z, 4 h ago
    expect(mine(u.id)).toHaveLength(0);
    expect((await rows(late)).find((r) => r.startsWith('d1'))).toMatch(/ skipped$/);
    await dispatch.dispatchDueReminders(new Date('2020-04-11T10:30:00Z'), fake());
    expect(mine(u.id)).toHaveLength(0);
    expect((await rows(gone)).every((r) => r.endsWith('canceled'))).toBe(true);
    // d0 of `late` (10:00Z) is due at 17:30Z, but the event started at 17:00Z
    await dispatch.dispatchDueReminders(new Date('2020-04-10T17:30:00Z'), fake());
    expect(mine(u.id)).toHaveLength(0);
    expect((await rows(late)).find((r) => r.startsWith('d0'))).toMatch(/ skipped$/);
  });
});
