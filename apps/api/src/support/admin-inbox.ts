// F19 FR-18 domain. Mutations take the `tx` that withAdmin opens (T3) so the audit row commits with them; e-mail goes out after commit via notifyAnswered.
import { sql, type SQL } from 'drizzle-orm';
import { ADMIN_LIMITS, err, ok, type AdminTicketDetail, type AdminTicketListQuery, type AdminTicketPage, type AdminTicketReplyInput, type Plan, type Result, adminTicketListQuerySchema } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { planOf } from '../billing/plan';
import { dbm } from '../db';
import { attachmentsOf } from './attachments';
import { firstNameOf } from '../notifications/names';
import { notify } from '../notifications/notify';
import { ticketUrl } from './tickets';

const UUID = /^[0-9a-f-]{36}$/i;
const ref = (id: string | null, name: string | null, email: string | null) => (id ? { id, name, email } : null);
const notFound = () => err('not_found', 'ticket not found');

type Row = { id: string; number: number; user_id: string | null; u_name: string | null; u_email: string | null; type: AdminTicketDetail['type']; subject: string; status: AdminTicketDetail['status']; assigned_to: string | null; a_name: string | null; a_email: string | null; last_user_message_at: string; created_at: string; context: AdminTicketDetail['context'] };
// Last public message, whitespace collapsed, <= ticketPreviewMax chars ("…" included); one scalar subselect, no N+1.
const PREVIEW = sql`select case when length(s.t) > ${ADMIN_LIMITS.ticketPreviewMax} then left(s.t, ${ADMIN_LIMITS.ticketPreviewMax - 1}) || '…' else s.t end as preview
  from (select regexp_replace(btrim(m.body), '\\s+', ' ', 'g') as t from support_messages m where m.ticket_id = t.id and not m.internal order by m.created_at desc, m.id desc limit 1) s`;
const SELECT = sql`select (${PREVIEW}) as preview, t.id, t.number, t.user_id, up.name as u_name, u.email as u_email, t.type, t.subject, t.status, t.assigned_to, ap.name as a_name, a.email as a_email,
  t.last_user_message_at, t.created_at, t.context
  from support_tickets t left join auth.users u on u.id = t.user_id left join profiles up on up.user_id = t.user_id
  left join auth.users a on a.id = t.assigned_to left join profiles ap on ap.user_id = t.assigned_to`;
const toRow = (r: Row) => ({
  id: r.id, number: r.number, user: ref(r.user_id, r.u_name, r.u_email), type: r.type, subject: r.subject, status: r.status,
  assignedTo: ref(r.assigned_to, r.a_name, r.a_email), lastUserMessageAt: new Date(r.last_user_message_at), createdAt: new Date(r.created_at),
});

export async function listTickets(adminId: string, rawQuery: AdminTicketListQuery): Promise<Result<AdminTicketPage>> {
  const { db } = await dbm();
  const q = adminTicketListQuerySchema.parse(rawQuery);
  const base: SQL[] = [];
  if (q.type) base.push(sql`t.type = ${q.type}`);
  if (q.assignedToMe) base.push(sql`t.assigned_to = ${adminId}`);
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    const num = /^#?(\d{1,9})$/.exec(q.q);
    base.push(sql`(t.subject ilike ${like} or u.email ilike ${like} or up.name ilike ${like}${num ? sql` or t.number = ${Number(num[1])}` : sql``})`);
  }
  const where = (extra: SQL[]) => { const all = [...base, ...extra]; return all.length ? sql`where ${sql.join(all, sql` and `)}` : sql``; };
  const from = sql`from support_tickets t left join auth.users u on u.id = t.user_id left join profiles up on up.user_id = t.user_id`;
  const [un] = await db.execute<{ n: number }>(sql`select count(*)::int as n ${from} ${where([sql`t.status <> 'resolved'`, sql`t.assigned_to is null`])}`);
  const counts = await db.execute<{ status: string; n: number }>(sql`select t.status, count(*)::int as n ${from} ${where([])} group by t.status`);
  const c = { all: 0, open: 0, in_review: 0, answered: 0, resolved: 0 };
  for (const r of counts) { c[r.status as keyof typeof c] = r.n; c.all += r.n; }
  const total = q.status ? c[q.status] : c.all;
  const rows = await db.execute<Row & { preview: string | null }>(sql`${SELECT} ${where(q.status ? [sql`t.status = ${q.status}`] : [])} order by t.last_user_message_at desc, t.number desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
  return ok({ items: rows.map((r) => ({ ...toRow(r), preview: r.preview ?? '' })), total, page: q.page, pageSize: q.pageSize, counts: { ...c, unassigned: un?.n ?? 0 } });
}

/** Admins see attachments here without a reason: the user sent them to support (D-432). Reads are not audited. */
export async function getTicket(_adminId: string, ticketId: string): Promise<Result<AdminTicketDetail>> {
  if (!UUID.test(ticketId)) return notFound();
  const { db } = await dbm();
  const [r] = await db.execute<Row>(sql`${SELECT} where t.id = ${ticketId}`);
  if (!r) return notFound();
  const msgs = await db.execute<{ id: string; author_type: 'user' | 'admin' | 'system'; author_id: string | null; name: string | null; email: string | null; body: string; internal: boolean; created_at: string }>(
    sql`select m.id, m.author_type, m.author_id, p.name, u.email, m.body, m.internal, m.created_at from support_messages m
      left join auth.users u on u.id = m.author_id left join profiles p on p.user_id = m.author_id where m.ticket_id = ${ticketId} order by m.created_at, m.id`);
  const files = await attachmentsOf(ticketId);
  const plan: Plan = r.user_id ? (await planOf(r.user_id)).plan : 'free';
  return ok({
    ...toRow(r), plan, context: r.context ?? null,
    messages: msgs.map((m) => ({
      id: m.id, authorType: m.author_type, author: ref(m.author_id, m.name, m.email), body: m.body, internal: m.internal, createdAt: new Date(m.created_at),
      attachments: files.filter((f) => f.messageId === m.id).map((f) => ({ id: f.id, mime: f.mime, sizeBytes: f.sizeBytes, url: f.url })),
    })),
  });
}

/** For the server-generated audit reason "Atendimento do chamado #N" (D-432). */
export async function ticketNumberOf(ticketId: string): Promise<number | null> {
  if (!UUID.test(ticketId)) return null;
  const { db } = await dbm();
  const [r] = await db.execute<{ number: number }>(sql`select number from support_tickets where id = ${ticketId}`);
  return r?.number ?? null;
}

type Locked = { id: string; number: number; user_id: string | null; status: string };
const lock = async (tx: Tx, ticketId: string) => (await tx.execute<Locked>(sql`select id, number, user_id, status from support_tickets where id = ${ticketId} for update`))[0];

/** Reply -> status answered, unread for the user. Internal note -> a hidden message only: no status change, no unread, no e-mail. */
export async function replyAsAdmin(tx: Tx, adminId: string, ticketId: string, input: AdminTicketReplyInput): Promise<Result<{ number: number; userId: string | null; messageId: string; internal: boolean; before: string; after: string }>> {
  const t = UUID.test(ticketId) ? await lock(tx, ticketId) : undefined;
  if (!t) return notFound();
  const internal = input.internal ?? false;
  const [msg] = await tx.execute<{ id: string }>(sql`insert into support_messages (ticket_id, author_type, author_id, body, internal) values (${ticketId}, 'admin', ${adminId}, ${input.body}, ${internal}) returning id`);
  if (!internal) await tx.execute(sql`update support_tickets set status = 'answered', resolved_at = null, last_admin_reply_at = now(), updated_at = now() where id = ${ticketId}`);
  return ok({ number: t.number, userId: t.user_id, messageId: msg!.id, internal, before: t.status, after: internal ? t.status : 'answered' });
}

/** Call after withAdmin commits. One notice per admin message (reference = message id). */
export async function notifyAnswered(userId: string | null, ticketId: string, number: number, messageId: string) {
  if (!userId) return;
  await notify(userId, 'support_reply', {
    reference: messageId,
    href: `/app/hoje?suporte=${ticketId}`,
    data: { ticketId, ticketNumber: number },
    email: { version: 'answered', name: await firstNameOf(userId), ticketNumber: number, ticketUrl: ticketUrl(ticketId) },
  });
}

export async function assignTicket(tx: Tx, adminId: string, ticketId: string): Promise<Result<{ before: string; after: string }>> {
  const t = UUID.test(ticketId) ? await lock(tx, ticketId) : undefined;
  if (!t) return notFound();
  if (t.status === 'resolved') return err('conflict', 'ticket resolved');
  await tx.execute(sql`update support_tickets set assigned_to = ${adminId}, status = case when status = 'open' then 'in_review'::support_ticket_status else status end, updated_at = now() where id = ${ticketId}`);
  return ok({ before: t.status, after: t.status === 'open' ? 'in_review' : t.status });
}

export async function resolveTicket(tx: Tx, ticketId: string): Promise<Result<{ type: string; userId: string | null; before: string; after: string }>> {
  const t = UUID.test(ticketId) ? await lock(tx, ticketId) : undefined;
  if (!t) return notFound();
  if (t.status === 'resolved') return err('conflict', 'already resolved');
  const [r] = await tx.execute<{ type: string }>(sql`update support_tickets set status = 'resolved', resolved_at = now(), updated_at = now() where id = ${ticketId} returning type`);
  return ok({ type: r!.type, userId: t.user_id, before: t.status, after: 'resolved' });
}
