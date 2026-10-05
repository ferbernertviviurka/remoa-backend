// Integration: needs local Supabase (see account.test.ts); skipped otherwise.
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendarEventSchema, calendarLabelListSchema, calendarSettingsSchema, upcomingEventsSchema } from '@remoa/contracts';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/calendar', () => {
  const users: string[] = [];
  let dbm: typeof import('@remoa/db');
  let app: ReturnType<typeof import('../app').createApp>;
  let ics: typeof import('./ics');
  const newUser = async (tz?: string) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql.raw(`insert into auth.users (id, email, instance_id, aud, role) values ('${id}', '${id}@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`));
    if (tz) await dbm.db.execute(sql`insert into profiles (user_id, timezone) values (${id}, ${tz}) on conflict (user_id) do update set timezone = ${tz}`);
    return id;
  };
  const raw = (user: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, { method, headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (user: string | null, method: string, path: string, body?: unknown) => {
    const res = await raw(user, method, path, body);
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const labelOf = async (u: string, key = 'exam') => ((await call(u, 'GET', '/calendar/labels')).json.data.labels as { id: string; systemKey: string }[]).find((l) => l.systemKey === key)!.id;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const day = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    ics = await import('./ics');
    const { createApp } = await import('../app');
    app = createApp({ webOrigin: 'http://localhost:3000', verifyToken: async (t) => (users.includes(t) ? t : null) });
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql.raw(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(',')})`));
  });

  it('requires auth', async () => {
    expect((await call(null, 'GET', '/calendar/events?from=2026-10-01&to=2026-10-31')).status).toBe(401);
    expect((await call(null, 'GET', '/calendar/labels')).status).toBe(401);
  });

  it('labels: seeds the 5 defaults once, CRUD, limit 20, delete moves events to personal, personal is permanent', async () => {
    const a = await newUser();
    const l = calendarLabelListSchema.parse((await call(a, 'GET', '/calendar/labels')).json.data);
    expect(l.labels.map((x) => x.systemKey)).toEqual(['exam', 'assignment', 'important_date', 'shift', 'personal']);
    expect((await call(a, 'GET', '/calendar/labels')).json.data.labels).toHaveLength(5); // not reseeded
    const exam = l.labels[0]!;
    const personal = l.labels[4]!;
    const mine = await call(a, 'POST', '/calendar/labels', { name: 'Estágio', color: 'blue' });
    expect(mine.status).toBe(201);
    const renamed = await call(a, 'PATCH', `/calendar/labels/${exam.id}`, { name: 'Provas', color: 'pink', hidden: true });
    expect(renamed.json.data).toMatchObject({ name: 'Provas', color: 'pink', hidden: true });
    expect((await call(a, 'GET', '/calendar/settings')).json.data.hiddenLabelIds).toEqual([exam.id]);
    expect((await call(a, 'PATCH', `/calendar/labels/${exam.id}`, {})).status).toBe(422);
    for (let i = 0; i < 14; i++) expect((await call(a, 'POST', '/calendar/labels', { name: `Etiqueta ${i}`, color: 'teal' })).status).toBe(201);
    const over = await call(a, 'POST', '/calendar/labels', { name: 'Demais', color: 'teal' });
    expect(over).toMatchObject({ status: 409, json: { error: { message: 'label_limit' } } });

    await call(a, 'POST', '/calendar/events', { title: 'Prova de CM', labelId: exam.id, date: day(3), allDay: true });
    const del = await call(a, 'DELETE', `/calendar/labels/${exam.id}`);
    expect(del.json.data).toEqual({ movedTo: personal.id, moved: 1 });
    expect((await call(a, 'GET', '/calendar/settings')).json.data.hiddenLabelIds).toEqual([]);
    expect(await call(a, 'DELETE', `/calendar/labels/${personal.id}`)).toMatchObject({ status: 409, json: { error: { message: 'label_personal' } } });
    expect((await call(a, 'DELETE', `/calendar/labels/${uuid()}`)).status).toBe(404);
  });

  it('events: create, validation, range, patch merge, reminders, duplicate +7 days, soft delete', async () => {
    const a = await newUser();
    const exam = await labelOf(a);
    const d = day(10);
    const created = await call(a, 'POST', '/calendar/events', { title: 'Prova de Clínica', labelId: exam, date: d, startTime: '08:30', endTime: '10:00', location: ' Sala 3 ', description: '' });
    expect(created.status).toBe(201);
    const ev = calendarEventSchema.parse(created.json.data);
    expect(ev).toMatchObject({ date: d, startTime: '08:30', endTime: '10:00', allDay: false, location: 'Sala 3', description: null, timezone: 'America/Sao_Paulo', remindD1: true, remindD0: true });
    expect(ev.startsAt.toISOString()).toBe(`${d}T11:30:00.000Z`); // 08:30 in São Paulo (UTC-3)

    expect((await call(a, 'POST', '/calendar/events', { title: 'x', labelId: exam, date: d, startTime: '08:00' })).status).toBe(422); // title too short
    expect((await call(a, 'POST', '/calendar/events', { title: 'Sem hora', labelId: exam, date: d })).status).toBe(422); // timed without start
    expect((await call(a, 'POST', '/calendar/events', { title: 'Dia todo', labelId: exam, date: d, allDay: true })).status).toBe(201);
    expect((await call(a, 'POST', '/calendar/events', { title: 'Rótulo alheio', labelId: uuid(), date: d, allDay: true })).json.error).toMatchObject({ code: 'validation', message: 'calendar_bad_label' });
    expect((await call(a, 'POST', '/calendar/events', { title: 'Capa alheia', labelId: exam, date: d, allDay: true, coverAssetId: uuid() })).json.error).toMatchObject({ message: 'calendar_bad_cover' });

    const range = await call(a, 'GET', `/calendar/events?from=${day(9)}&to=${day(11)}`);
    expect(range.json.data.events.map((e: { title: string }) => e.title)).toEqual(['Dia todo', 'Prova de Clínica'].sort((x) => (x === 'Dia todo' ? -1 : 1))); // all-day = local midnight first
    expect((await call(a, 'GET', `/calendar/events?from=${day(0)}&to=${day(120)}`)).status).toBe(422);
    expect((await call(a, 'GET', `/calendar/events?from=${day(20)}&to=${day(30)}`)).json.data.events).toHaveLength(0);

    const p = await call(a, 'PATCH', `/calendar/events/${ev.id}`, { startTime: '07:00', title: 'Prova final' });
    expect(p.json.data).toMatchObject({ title: 'Prova final', startTime: '07:00', endTime: '10:00' });
    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}`, { endTime: '06:00' })).status).toBe(422); // merged row: end before start
    const allDay = await call(a, 'PATCH', `/calendar/events/${ev.id}`, { allDay: true });
    expect(allDay.json.data).toMatchObject({ allDay: true, startTime: null, endTime: null });
    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}`, { allDay: false })).status).toBe(422); // timed needs a start
    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}`, { allDay: false, startTime: '09:00' })).json.data).toMatchObject({ startTime: '09:00' });

    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}/reminders`, { remindD1: false })).json.data).toMatchObject({ remindD1: false, remindD0: true });
    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}/reminders`, {})).status).toBe(422);

    const dup = await call(a, 'POST', `/calendar/events/${ev.id}/duplicate`, {});
    expect(dup.status).toBe(201);
    expect(dup.json.data).toMatchObject({ title: 'Prova final', date: day(17), startTime: '09:00', remindD1: false });
    expect(dup.json.data.id).not.toBe(ev.id);
    expect((await call(a, 'POST', `/calendar/events/${ev.id}/duplicate`, { days: 1 })).json.data.date).toBe(day(11));

    expect((await call(a, 'DELETE', `/calendar/events/${ev.id}`)).status).toBe(200);
    expect((await call(a, 'DELETE', `/calendar/events/${ev.id}`)).status).toBe(404);
    expect((await call(a, 'PATCH', `/calendar/events/${ev.id}`, { title: 'Ainda' })).status).toBe(404);
    const [row] = await dbm.db.select().from(dbm.calendarEvents).where(sql`id = ${ev.id}`);
    expect(row!.deletedAt).not.toBeNull(); // soft
    expect((await call(a, 'GET', `/calendar/events?from=${d}&to=${d}`)).json.data.events.map((e: { id: string }) => e.id)).not.toContain(ev.id);
  });

  it("RLS: another user cannot read, edit, duplicate, delete or use someone else's event or label", async () => {
    const a = await newUser();
    const b = await newUser();
    const d = day(5);
    const ev = (await call(a, 'POST', '/calendar/events', { title: 'Plantão A', labelId: await labelOf(a, 'shift'), date: d, allDay: true })).json.data;
    const bShift = await labelOf(b, 'shift');
    expect((await call(b, 'GET', `/calendar/events?from=${d}&to=${d}`)).json.data.events).toHaveLength(0);
    for (const [m, p, body] of [['PATCH', `/calendar/events/${ev.id}`, { title: 'Hackeado' }], ['DELETE', `/calendar/events/${ev.id}`], ['POST', `/calendar/events/${ev.id}/duplicate`, {}], ['PATCH', `/calendar/events/${ev.id}/reminders`, { remindD0: false }], ['GET', `/calendar/events/${ev.id}.ics`]] as const) {
      expect((await call(b, m, p, body)).status, `${m} ${p}`).toBe(404);
    }
    expect((await call(b, 'POST', '/calendar/events', { title: 'Com rótulo de A', labelId: await labelOf(a, 'shift'), date: d, allDay: true })).json.error?.message).toBe('calendar_bad_label');
    expect((await call(b, 'PATCH', `/calendar/events/${ev.id}`, { labelId: bShift })).status).toBe(404);
    expect((await call(b, 'DELETE', `/calendar/labels/${await labelOf(a, 'shift')}`)).status).toBe(404);
    expect((await call(b, 'PATCH', `/calendar/labels/${await labelOf(a, 'shift')}`, { name: 'Hackeado' })).status).toBe(404);
    expect((await call(a, 'GET', `/calendar/events?from=${d}&to=${d}`)).json.data.events[0].title).toBe('Plantão A');
  });

  it('upcoming: from today on in the profile timezone, hidden labels included, daysUntil, within24h, limit', async () => {
    const a = await newUser('Asia/Tokyo');
    const exam = await labelOf(a);
    await call(a, 'PATCH', `/calendar/labels/${exam}`, { hidden: true });
    expect((await call(a, 'GET', '/calendar/upcoming')).json.data).toEqual({ events: [], within24h: false });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    await call(a, 'POST', '/calendar/events', { title: 'Hoje o dia todo', labelId: exam, date: today, allDay: true });
    await call(a, 'POST', '/calendar/events', { title: 'Depois de amanhã', labelId: exam, date: plus(2), startTime: '09:00' });
    await call(a, 'POST', '/calendar/events', { title: 'Amanhã cedo', labelId: exam, date: plus(1), startTime: '00:30' });
    await call(a, 'POST', '/calendar/events', { title: 'Lá longe', labelId: exam, date: plus(40), allDay: true });
    const r = await call(a, 'GET', '/calendar/upcoming?limit=3');
    const up = upcomingEventsSchema.parse(r.json.data);
    expect(up.events.map((e) => [e.title, e.daysUntil])).toEqual([['Hoje o dia todo', 0], ['Amanhã cedo', 1], ['Depois de amanhã', 2]]);
    expect(up.events[0]).toMatchObject({ labelName: 'Prova', color: 'orange' });
    expect((await call(a, 'GET', '/calendar/upcoming?limit=11')).status).toBe(422);
    const b = await newUser();
    expect((await call(b, 'GET', '/calendar/upcoming')).json.data.events).toHaveLength(0);
    // an event starting within 24 h lights the dot
    const soon = await dbm.db.insert(dbm.calendarEvents).values({ userId: b, title: 'Daqui a pouco', labelId: await labelOf(b), startsAt: new Date(Date.now() + 3 * 3_600_000), timezone: 'America/Sao_Paulo' }).returning();
    expect(soon).toHaveLength(1);
    expect((await call(b, 'GET', '/calendar/upcoming')).json.data.within24h).toBe(true);
  });

  it('settings: view, tour-seen keeps the first timestamp, timezone from the profile', async () => {
    const a = await newUser('America/Manaus');
    expect(calendarSettingsSchema.parse((await call(a, 'GET', '/calendar/settings')).json.data)).toMatchObject({ view: null, tourSeenAt: null, timezone: 'America/Manaus', hiddenLabelIds: [] });
    expect((await call(a, 'PATCH', '/calendar/view', { view: 'week' })).json.data).toEqual({ view: 'week' });
    expect((await call(a, 'PATCH', '/calendar/view', { view: 'year' })).status).toBe(422);
    const t1 = (await call(a, 'POST', '/calendar/tour-seen')).json.data.tourSeenAt;
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(a, 'POST', '/calendar/tour-seen')).json.data.tourSeenAt).toBe(t1);
    expect((await call(a, 'GET', '/calendar/settings')).json.data).toMatchObject({ view: 'week', tourSeenAt: t1 });
  });

  it('.ics: authenticated and public token, UTC time, all-day as DATE, escaped, no VALARM; bad token is 404', async () => {
    const a = await newUser();
    const exam = await labelOf(a);
    const d = day(4);
    const ev = (await call(a, 'POST', '/calendar/events', { title: 'Prova; de, Clínica', labelId: exam, date: d, startTime: '08:30', endTime: '10:00', location: 'Sala 3', description: 'Linha 1\nLinha 2' })).json.data;
    const res = await raw(a, 'GET', `/calendar/events/${ev.id}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    const stamp = (h: string) => `${d.replaceAll('-', '')}T${h}00Z`;
    expect(body).toContain('BEGIN:VCALENDAR\r\n');
    expect(body).toContain(`DTSTART:${stamp('1130')}`);
    expect(body).toContain(`DTEND:${stamp('1300')}`);
    expect(body).toContain('SUMMARY:Prova\; de\\, Clínica');
    expect(body).toContain('DESCRIPTION:Linha 1\\nLinha 2');
    expect(body).not.toContain('VALARM');
    expect(body.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);

    const url = new URL(ics.icsUrlFor(ev.id));
    expect(url.pathname).toMatch(/^\/v1\/public\/calendar\/[0-9a-f-]{36}\.[\w-]+\.ics$/);
    const pub = await app.request(url.pathname); // no Authorization
    expect(pub.status).toBe(200);
    expect(await pub.text()).toBe(body);
    const bad = url.pathname.replace(/\.[\w-]+\.ics$/, '.AAAA.ics');
    expect((await app.request(bad)).status).toBe(404);
    expect((await app.request(`/v1/public/calendar/${ev.id}.ics`)).status).toBe(404);
    expect(ics.eventOfIcsToken(ics.icsToken(ev.id))).toBe(ev.id);
    expect(ics.eventOfIcsToken(`${uuid()}.${ics.icsToken(ev.id).split('.')[1]}`)).toBeNull(); // signature is bound to the id

    const allDay = (await call(a, 'POST', '/calendar/events', { title: 'Feriado', labelId: exam, date: d, allDay: true })).json.data;
    const b2 = await (await raw(a, 'GET', `/calendar/events/${allDay.id}.ics`)).text();
    const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
    expect(b2).toContain(`DTSTART;VALUE=DATE:${d.replaceAll('-', '')}`);
    expect(b2).toContain(`DTEND;VALUE=DATE:${next}`);
    await call(a, 'DELETE', `/calendar/events/${allDay.id}`);
    expect((await app.request(new URL(ics.icsUrlFor(allDay.id)).pathname)).status).toBe(404);
  });

  it('cover: own asset is accepted and returns signed URLs; someone else\'s asset is calendar_bad_cover', async () => {
    const a = await newUser();
    const b = await newUser();
    const [mine] = await dbm.db.insert(dbm.assets).values({ userId: a, key: `assets/${a}/${uuid()}`, mime: 'image/webp' }).returning();
    const [theirs] = await dbm.db.insert(dbm.assets).values({ userId: b, key: `assets/${b}/${uuid()}`, mime: 'image/webp' }).returning();
    const exam = await labelOf(a);
    const ok = await call(a, 'POST', '/calendar/events', { title: 'Com capa', labelId: exam, date: day(2), allDay: true, coverAssetId: mine!.id });
    expect(ok.status).toBe(201);
    expect(ok.json.data.cover).toMatchObject({ assetId: mine!.id, urls: { w800: expect.stringContaining('w800.webp'), w1600: expect.stringContaining('w1600.webp') } });
    expect((await call(a, 'POST', '/calendar/events', { title: 'Capa do B', labelId: exam, date: day(2), allDay: true, coverAssetId: theirs!.id })).json.error?.message).toBe('calendar_bad_cover');
    const cleared = await call(a, 'PATCH', `/calendar/events/${ok.json.data.id}`, { coverAssetId: null });
    expect(cleared.json.data.cover).toBeNull();
  });
});
