// Integration (F19 T2): inbox routes through the real withAdmin; the admin identity is stubbed (requireAdmin is T3's and tested there).
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID as uuid } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@remoa/log';
import type { AdminEnv } from '../core/require-admin';

config({ path: '../../.env' });

describe.skipIf(!process.env.DATABASE_URL)('/v1/admin/tickets (inbox routes)', () => {
  let dbm: typeof import('@remoa/db');
  let app: Hono<AdminEnv>;
  let sent: Awaited<ReturnType<typeof import('../../test-email')['captureEmails']>>;
  const users: string[] = [];
  const mk = async (name: string) => {
    const id = uuid();
    users.push(id);
    await dbm.db.execute(sql`insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data) values (${id}, ${id + '@test.local'}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ name })}::jsonb)`);
    return id;
  };
  const req = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(`/tickets${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  let adm: string;
  let student: string;
  let ticket: { id: string; number: number };
  const audits = (id: string) => dbm.db.execute<{ action: string; reason: string; result: string; after: unknown }>(sql`select action, reason, result, after from admin_audit_log where target_id = ${id} order by id`);

  beforeAll(async () => {
    dbm = await import('@remoa/db');
    sent = (await import('../../test-email')).captureEmails();
    const { ticketsRoutes } = await import('./routes');
    adm = await mk('Equipe');
    student = await mk('Aluno');
    app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('admin', { id: adm, name: 'Equipe', email: 'e@test.local' });
      c.set('authAt', Date.now());
      c.set('requestId', 'r1');
      c.set('log', createLogger({ requestId: 'r1' }));
      await next();
    });
    app.route('/tickets', ticketsRoutes);
    const [t] = await dbm.db.execute<{ id: string; number: number }>(sql`insert into support_tickets (user_id, type, subject) values (${student}, 'bug', 'Erro ao revisar') returning id, number`);
    await dbm.db.execute(sql`insert into support_messages (ticket_id, author_type, body) values (${t!.id}, 'user', 'Não abre a fila.')`);
    ticket = t!;
  });
  afterAll(async () => {
    if (dbm && users.length) await dbm.db.execute(sql`delete from auth.users where id in (${sql.join(users.map((u) => sql`${u}`), sql`, `)})`);
  });

  it('list + detail', async () => {
    const l = await req('?status=open');
    expect(l.status).toBe(200);
    expect(l.json.data.items.some((i: { id: string }) => i.id === ticket.id)).toBe(true);
    expect(l.json.data.counts.all).toBeGreaterThan(0);
    expect((await req('?pageSize=500')).status).toBe(422);
    expect((await req(`/${ticket.id}`)).json.data.messages).toHaveLength(1);
    expect((await req(`/${uuid()}`)).status).toBe(404);
  });

  it('list preview: last non-internal message, whitespace collapsed, <= 140 with an ellipsis; counts.unassigned', async () => {
    const [t] = await dbm.db.execute<{ id: string; number: number }>(sql`insert into support_tickets (user_id, type, subject) values (${student}, 'other', 'Prévia') returning id, number`);
    const msg = (author: string, body: string, internal = false, at = 0) => dbm.db.execute(sql`insert into support_messages (ticket_id, author_type, body, internal, created_at) values (${t!.id}, ${author}, ${body}, ${internal}, now() + make_interval(secs => ${at}))`);
    await msg('user', 'primeira');
    await msg('user', `  linha um\n\n  linha   dois ${'x'.repeat(200)}`, false, 1);
    await msg('admin', 'nota interna secreta', true, 2);
    const row = async () => (await req(`?q=${t!.number}`)).json.data;
    const d = await row();
    const item = d.items.find((i: { id: string }) => i.id === t!.id);
    expect(item.preview).toHaveLength(140);
    expect(item.preview.startsWith('linha um linha dois xxx')).toBe(true);
    expect(item.preview.endsWith('…')).toBe(true);
    expect(item.preview).not.toContain('secreta');
    expect(d.counts.unassigned).toBe(1);
    await dbm.db.execute(sql`update support_tickets set assigned_to = ${adm} where id = ${t!.id}`);
    expect((await row()).counts.unassigned).toBe(0);
    await dbm.db.execute(sql`update support_tickets set assigned_to = null, status = 'resolved', resolved_at = now() where id = ${t!.id}`);
    expect((await row()).counts.unassigned).toBe(0); // resolved never counts
    await dbm.db.execute(sql`delete from support_tickets where id = ${t!.id}`);
  });

  it('assign, internal note, reply, resolve: one audit row each, generated reason, no message text in audit, e-mail only for the reply', async () => {
    expect((await req(`/${ticket.id}/assign`, 'POST')).status).toBe(200);
    const note = await req(`/${ticket.id}/messages`, 'POST', { body: 'nota fechada', internal: true });
    expect(note.status).toBe(200);
    expect(note.json.data.audit.action).toBe('ticket.internal_note');
    const before = sent.length;
    expect((await req(`/${ticket.id}/messages`, 'POST', { body: 'Resposta pública' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.length - before).toBe(1);
    expect((await req(`/${ticket.id}/resolve`, 'POST')).status).toBe(200);
    expect((await req(`/${ticket.id}/resolve`, 'POST')).status).toBe(409); // already resolved: denied, invalid_state
    const rows = await audits(ticket.id);
    expect(rows.map((r) => [r.action, r.result])).toEqual([['ticket.assign', 'success'], ['ticket.internal_note', 'success'], ['ticket.reply', 'success'], ['ticket.resolve', 'success'], ['ticket.resolve', 'denied']]);
    expect(rows.every((r) => r.reason === `Atendimento do chamado #${ticket.number}`)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/nota fechada|Resposta pública/);
    expect((await req(`/${ticket.id}/messages`, 'POST', { body: '' })).status).toBe(422);
    expect((await req(`/${uuid()}/messages`, 'POST', { body: 'x' })).status).toBe(404);
    expect((await req(`/${uuid()}/assign`, 'POST')).status).toBe(404);
  });
});
