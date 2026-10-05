// G18 RLS (CCR-034): notifications, notification_preferences, email_deliveries, calendar_*. Needs local Supabase; skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('G18 RLS', () => {
  const db = sql!;
  const [alice, bob] = [randomUUID(), randomUUID()];
  const ids = { aLabel: randomUUID(), aPersonal: randomUUID(), bLabel: randomUUID(), aAsset: randomUUID(), bAsset: randomUUID(), aEvent: randomUUID(), aNotif: randomUUID() };
  /** Runs fn as `authenticated` uid and always rolls back. */
  const as = <T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
      await tx`set local role authenticated`;
      const out = await fn(tx);
      throw Object.assign(new Error('rollback'), { out });
    }).catch((e: { out?: T }) => { if ('out' in e) return e.out as T; throw e; });

  beforeAll(async () => {
    for (const id of [alice, bob]) await db`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
    await db`insert into calendar_labels (id, user_id, name, color, system_key) values
      (${ids.aLabel}, ${alice}, 'Prova', 'orange', 'exam'), (${ids.aPersonal}, ${alice}, 'Pessoal', 'gray', 'personal'), (${ids.bLabel}, ${bob}, 'Prova', 'orange', 'exam')`;
    await db`insert into assets (id, user_id, key, mime) values (${ids.aAsset}, ${alice}, ${`assets/${alice}/x`}, 'image/webp'), (${ids.bAsset}, ${bob}, ${`assets/${bob}/x`}, 'image/webp')`;
    await db`insert into calendar_events (id, user_id, title, label_id, starts_at, timezone) values (${ids.aEvent}, ${alice}, 'Prova de CM', ${ids.aLabel}, now() + interval '2 days', 'America/Sao_Paulo')`;
    await db`insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at) values (${alice}, ${ids.aEvent}, 'd1', current_date + 2, now() + interval '1 day')`;
    await db`insert into notifications (id, user_id, type, category, data, idempotency_key, href) values (${ids.aNotif}, ${alice}, 'review_reminder', 'review', '{"cards":3}', 'review_reminder:2026-10-05', '/app/revisar')`;
    await db`insert into email_deliveries (user_id, template, reference, to_hash) values (${alice}, 'review-reminder', ${`rr:${alice}`}, ${'a'.repeat(64)})`;
  });
  afterAll(async () => {
    await db`delete from auth.users where id in (${alice}, ${bob})`;
    await db.end();
  });

  it('notifications: owner reads and marks read/dismissed only; no insert or delete from the client', async () => {
    expect((await as(alice, (tx) => tx`select id from notifications`)).map((r) => r.id)).toEqual([ids.aNotif]);
    expect(await as(bob, (tx) => tx`select id from notifications`)).toHaveLength(0);
    expect((await as(alice, (tx) => tx`update notifications set read_at = now(), dismissed_at = now() where id = ${ids.aNotif} returning id`))).toHaveLength(1);
    expect(await as(bob, (tx) => tx`update notifications set read_at = now() where id = ${ids.aNotif} returning id`)).toHaveLength(0);
    await expect(as(alice, (tx) => tx`update notifications set data = '{}' where id = ${ids.aNotif}`)).rejects.toThrow();
    await expect(as(alice, (tx) => tx`insert into notifications (user_id, type, category, idempotency_key) values (${alice}, 'purchase', 'account_billing', 'x')`)).rejects.toThrow();
    await expect(as(alice, (tx) => tx`delete from notifications where id = ${ids.aNotif}`)).rejects.toThrow();
  });

  it('notifications: idempotency key is unique per user; href must be an app path', async () => {
    await expect(db`insert into notifications (user_id, type, category, idempotency_key) values (${alice}, 'review_reminder', 'review', 'review_reminder:2026-10-05')`).rejects.toThrow();
    await expect(db`insert into notifications (user_id, type, category, idempotency_key, href) values (${alice}, 'purchase', 'account_billing', 'p:1', 'https://evil.test')`).rejects.toThrow();
  });

  it('notification_preferences: own rows; fixed e-mails cannot be turned off by anyone', async () => {
    expect(await as(alice, (tx) => tx`insert into notification_preferences (user_id, key, in_app, email) values (${alice}, 'map_ready', true, false) returning key`)).toHaveLength(1);
    await expect(as(alice, (tx) => tx`insert into notification_preferences (user_id, key, in_app, email) values (${bob}, 'map_ready', true, false)`)).rejects.toThrow();
    await expect(as(alice, (tx) => tx`insert into notification_preferences (user_id, key, in_app, email) values (${alice}, 'support', true, false)`)).rejects.toThrow();
    await expect(db`insert into notification_preferences (user_id, key, in_app, email) values (${alice}, 'account_billing', true, false)`).rejects.toThrow();
  });

  it('email_deliveries is server-only', async () => {
    await expect(as(alice, (tx) => tx`select 1 from email_deliveries`)).rejects.toThrow();
    await expect(as(alice, (tx) => tx`insert into email_deliveries (template, reference, to_hash) values ('map-ready', 'x', ${'b'.repeat(64)})`)).rejects.toThrow();
    await expect(db`insert into email_deliveries (user_id, template, reference, to_hash) values (${bob}, 'review-reminder', ${`rr:${alice}`}, ${'a'.repeat(64)})`).rejects.toThrow(); // (template, reference)
  });

  it('calendar_labels: own only; personal cannot be deleted', async () => {
    expect((await as(alice, (tx) => tx`select id from calendar_labels order by name`)).map((r) => r.id)).toEqual([ids.aPersonal, ids.aLabel]);
    expect(await as(alice, (tx) => tx`delete from calendar_labels where id = ${ids.aPersonal} returning id`)).toHaveLength(0);
    expect(await as(alice, (tx) => tx`delete from calendar_labels where id = ${ids.bLabel} returning id`)).toHaveLength(0);
    await expect(as(alice, (tx) => tx`insert into calendar_labels (user_id, name, color, system_key) values (${alice}, 'Prova 2', 'blue', 'exam')`)).rejects.toThrow(); // one per system key
  });

  it('calendar_events: own label and own cover only; soft delete, no hard delete; B sees nothing', async () => {
    const ins = (tx: postgres.TransactionSql, label: string, cover: string | null) =>
      tx`insert into calendar_events (user_id, title, label_id, starts_at, timezone, cover_asset_id) values (${alice}, 'Plantão', ${label}, now(), 'America/Sao_Paulo', ${cover}) returning id`;
    expect(await as(alice, (tx) => ins(tx, ids.aLabel, ids.aAsset))).toHaveLength(1);
    await expect(as(alice, (tx) => ins(tx, ids.bLabel, null))).rejects.toThrow();
    await expect(as(alice, (tx) => ins(tx, ids.aLabel, ids.bAsset))).rejects.toThrow();
    await expect(as(alice, (tx) => tx`update calendar_events set label_id = ${ids.bLabel} where id = ${ids.aEvent}`)).rejects.toThrow();
    expect(await as(alice, (tx) => tx`update calendar_events set deleted_at = now() where id = ${ids.aEvent} returning id`)).toHaveLength(1);
    await expect(as(alice, (tx) => tx`delete from calendar_events where id = ${ids.aEvent}`)).rejects.toThrow();
    expect(await as(bob, (tx) => tx`select id from calendar_events`)).toHaveLength(0);
    await expect(db`insert into calendar_events (user_id, title, label_id, starts_at, ends_at, timezone) values (${alice}, 'X', ${ids.aLabel}, now(), now() - interval '1 hour', 'UTC')`).rejects.toThrow(); // title < 2 and end < start
  });

  it('calendar_reminders: owner reads, only the server writes; one row per (event, kind, date)', async () => {
    expect(await as(alice, (tx) => tx`select kind from calendar_reminders`)).toHaveLength(1);
    expect(await as(bob, (tx) => tx`select kind from calendar_reminders`)).toHaveLength(0);
    await expect(as(alice, (tx) => tx`update calendar_reminders set status = 'canceled'`)).rejects.toThrow();
    await expect(db`insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at) values (${alice}, ${ids.aEvent}, 'd1', current_date + 2, now())`).rejects.toThrow();
  });

  it('user_preferences: new F25/F26 columns are the owner\'s; reminder_hour only 7/8/12/20', async () => {
    expect(await as(alice, (tx) => tx`insert into user_preferences (user_id, notif_pause_reminders, calendar_view, calendar_hidden_labels) values (${alice}, true, 'agenda', ${[ids.aLabel]}::uuid[]) returning user_id`)).toHaveLength(1);
    await expect(db`insert into user_preferences (user_id, reminder_hour) values (${bob}, 19)`).rejects.toThrow();
    await expect(db`insert into user_preferences (user_id, calendar_view) values (${bob}, 'year')`).rejects.toThrow();
  });

  it('email_suppressions: reason is constrained', async () => {
    await expect(db`insert into email_suppressions (email_hash, reason) values (${'c'.repeat(64)}, 'whatever')`).rejects.toThrow();
  });

  it('account deletion cascades everything', async () => {
    const c = randomUUID();
    await db`insert into auth.users (id, email) values (${c}, ${`${c}@test.remoa`})`;
    const [l] = await db`insert into calendar_labels (user_id, name, color) values (${c}, 'Minha', 'pink') returning id`;
    const [e] = await db`insert into calendar_events (user_id, title, label_id, starts_at, timezone) values (${c}, 'Evento', ${l!.id}, now(), 'UTC') returning id`;
    await db`insert into calendar_reminders (user_id, event_id, kind, occurrence_date, send_at) values (${c}, ${e!.id}, 'd0', current_date, now())`;
    await db`insert into notifications (user_id, type, category, idempotency_key) values (${c}, 'purchase', 'account_billing', 'p:1')`;
    await db`insert into notification_preferences (user_id, key, in_app, email) values (${c}, 'store', false, false)`;
    await db`delete from auth.users where id = ${c}`;
    const [n] = await db`select (select count(*) from calendar_labels where user_id = ${c}) + (select count(*) from calendar_events where user_id = ${c})
      + (select count(*) from calendar_reminders where user_id = ${c}) + (select count(*) from notifications where user_id = ${c})
      + (select count(*) from notification_preferences where user_id = ${c}) as n`;
    expect(Number(n!.n)).toBe(0);
  });

  it('CCR-037 (P-323): profiles.timezone is server-only (the API replans reminders); other profile columns stay writable', async () => {
    const [p] = await db`select has_column_privilege('authenticated', 'public.profiles', 'timezone', 'UPDATE') as tz, has_column_privilege('authenticated', 'public.profiles', 'name', 'UPDATE') as name`;
    expect(p).toEqual({ tz: false, name: true });
  });
});
