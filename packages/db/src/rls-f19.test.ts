// F19 RLS (D-427, D-429): user reads only own tickets / non-internal messages; server-only tables; append-only audit log.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const url = process.env.DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

describe.skipIf(!sql)('F19 RLS', () => {
  const db = sql!;
  const [alice, bob] = [randomUUID(), randomUUID()];
  let ticket = '';

  /** Runs `fn` as `authenticated` with auth.uid() = uid, rolled back. */
  const as = <T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    db.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
      await tx`set local role authenticated`;
      const out = await fn(tx);
      throw Object.assign(new Error('rollback'), { out });
    }).catch((e: { out?: T }) => { if ('out' in e) return e.out as T; throw e; });

  beforeAll(async () => {
    for (const id of [alice, bob]) await db`insert into auth.users (id, email) values (${id}, ${`${id}@test.remoa`})`;
    ticket = (await db`insert into support_tickets (user_id, type, subject) values (${alice}, 'bug', 'Não salva') returning id`)[0]!.id;
    const pub = (await db`insert into support_messages (ticket_id, author_type, author_id, body) values (${ticket}, 'user', ${alice}, 'Descrição do problema') returning id`)[0]!.id;
    await db`insert into support_messages (ticket_id, author_type, body, internal) values (${ticket}, 'admin', 'nota interna', true)`;
    await db`insert into support_attachments (ticket_id, message_id, key, mime, size) values (${ticket}, ${pub}, ${`support/${alice}/${randomUUID()}`}, 'image/png', 10)`;
  });
  afterAll(async () => {
    await db`delete from auth.users where id in (${alice}, ${bob})`;
    await db.end();
  });

  it('owner sees the ticket, non-internal messages and attachments; another user sees nothing', async () => {
    expect(await as(alice, (tx) => tx`select id from support_tickets`)).toHaveLength(1);
    const msgs = await as(alice, (tx) => tx`select body from support_messages where ticket_id = ${ticket}`);
    expect(msgs.map((m) => m.body)).toEqual(['Descrição do problema']);
    expect(await as(alice, (tx) => tx`select id from support_attachments`)).toHaveLength(1);
    expect(await as(bob, (tx) => tx`select id from support_tickets`)).toHaveLength(0);
    expect(await as(bob, (tx) => tx`select id from support_messages`)).toHaveLength(0);
  });

  it('assigned_to and author_id are not readable by the user', async () => {
    await expect(as(alice, (tx) => tx`select assigned_to from support_tickets`)).rejects.toThrow(/permission denied/);
    await expect(as(alice, (tx) => tx`select author_id from support_messages`)).rejects.toThrow(/permission denied/);
  });

  it('the user cannot write support rows', async () => {
    await expect(as(alice, (tx) => tx`insert into support_tickets (user_id, type, subject) values (${alice}, 'bug', 'Teste 123')`)).rejects.toThrow(/permission denied/);
    await expect(as(alice, (tx) => tx`update support_tickets set status = 'resolved'`)).rejects.toThrow(/permission denied/);
  });

  it('payments, admin_audit_log and admin_metrics_daily are server-only', async () => {
    for (const t of ['payments', 'admin_audit_log', 'admin_metrics_daily'])
      await expect(as(alice, (tx) => tx`select 1 from ${tx(t)}`)).rejects.toThrow(/permission denied/);
  });

  it('admin_audit_log is append-only even for the server connection', async () => {
    const id = (await db`insert into admin_audit_log (actor_type, action, result, denial) values ('user', 'admin.access', 'denied', 'not_admin') returning id`)[0]!.id;
    await expect(db`update admin_audit_log set reason = 'x' where id = ${id}`).rejects.toThrow(/append-only/);
    await expect(db`delete from admin_audit_log where id = ${id}`).rejects.toThrow(/append-only/);
    await expect(db`truncate admin_audit_log`).rejects.toThrow(/append-only/);
  });

  it('a successful admin action needs a reason of at least 8 characters', async () => {
    await expect(db`insert into admin_audit_log (actor_type, action, result, reason) values ('admin', 'user.suspend', 'success', 'curto')`).rejects.toThrow(/admin_audit_log_reason/);
  });
});
