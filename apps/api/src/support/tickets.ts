// F19 FR-3..FR-9, user side. Server-owned writes on the superuser connection with explicit user filters (D-427: users have no write grants).
import { and, asc, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { pick } from '../pick';
import {
  err, ok, SUPPORT_LIMITS, supportErrors,
  type GetMyTicket, type GetSupportUnread, type ListMyTickets, type MarkTicketRead, type ReplyToTicket, type SubmitSupportTicket, type SupportTicketDetail,
} from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import { env } from '@remoa/config';
import { notify } from '../notifications/notify';
import { firstNameOf } from '../notifications/names';
import { dbm } from '../db';
import { deleteObject } from '../storage/storage';
import { attachmentsOf, processAttachments, type StoredAttachment } from './attachments';
import { invalidate } from '../cache';

const DAY = 86_400_000;
export const ticketUrl = (id: string) => `${env().appUrl}/app/hoje?suporte=${id}`;

const dropFiles = (files: StoredAttachment[]) => Promise.all(files.map((f) => deleteObject(f.key))).catch(() => undefined);

const insertAttachments = async (tx: Tx, ticketId: string, messageId: string, files: StoredAttachment[]) => {
  if (!files.length) return;
  const { supportAttachments } = await dbm();
  await tx.insert(supportAttachments).values(files.map((f) => ({ ticketId, messageId, key: f.key, mime: f.mime, size: f.size })));
};

export const submitSupportTicket: SubmitSupportTicket = async (userId, input) => {
  const { db, supportTickets, supportMessages } = await dbm();
  const files = await processAttachments(userId, input.attachments ?? []);
  if (!files.ok) return files;
  const cleanup = () => dropFiles(files.data);
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'support:' + userId}))`); // concurrent submits cannot both pass the limits
    const mine = (since: number) => and(eq(supportTickets.userId, userId), gt(supportTickets.createdAt, new Date(Date.now() - since)));
    const [dup] = await tx
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .innerJoin(supportMessages, and(eq(supportMessages.ticketId, supportTickets.id), eq(supportMessages.authorType, 'user')))
      .where(and(mine(SUPPORT_LIMITS.duplicateWindowMinutes * 60_000), eq(supportTickets.subject, input.subject), eq(supportMessages.body, input.description)))
      .limit(1);
    if (dup) return err('conflict', supportErrors.duplicate);
    const count = async (since: number) => (await tx.select({ n: sql<number>`count(*)::int` }).from(supportTickets).where(mine(since)))[0]!.n;
    if ((await count(3_600_000)) >= SUPPORT_LIMITS.ticketsPerHour || (await count(DAY)) >= SUPPORT_LIMITS.ticketsPerDay) return err('rate_limited', supportErrors.rateLimited);
    const [t] = await tx.insert(supportTickets).values({ userId, type: input.type, subject: input.subject, context: input.context }).returning({ id: supportTickets.id, number: supportTickets.number });
    const [m] = await tx.insert(supportMessages).values({ ticketId: t!.id, authorType: 'user', body: input.description }).returning({ id: supportMessages.id });
    await insertAttachments(tx, t!.id, m!.id, files.data);
    return ok(t!);
  });
  if (!out.ok) {
    await cleanup();
    return out;
  }
  await invalidate('support.changed', { userId }); // after COMMIT: the user's ticket list and the admin overview
  // Rows are committed; notify() never throws. One "received" notice per ticket.
  await notify(userId, 'support_received', { reference: out.data.id, email: { version: 'received', name: await firstNameOf(userId), ticketNumber: out.data.number, ticketUrl: ticketUrl(out.data.id) } });
  return out;
};

const isUnread = (t: { lastAdminReplyAt: Date | null; lastUserReadAt: Date | null }) => !!t.lastAdminReplyAt && (!t.lastUserReadAt || t.lastAdminReplyAt > t.lastUserReadAt);

export const listMyTickets: ListMyTickets = async (userId) => {
  const { db, supportTickets: t } = await dbm();
  const rows = await db.select(pick(t, 'id', 'number', 'type', 'subject', 'status', 'createdAt', 'lastAdminReplyAt', 'lastUserReadAt', 'lastUserMessageAt')).from(t).where(eq(t.userId, userId)).orderBy(desc(t.createdAt));
  return ok(rows.map((r) => ({ id: r.id, number: r.number, type: r.type, subject: r.subject, status: r.status, unread: isUnread(r), createdAt: r.createdAt, updatedAt: r.lastAdminReplyAt && r.lastAdminReplyAt > r.lastUserMessageAt ? r.lastAdminReplyAt : r.lastUserMessageAt })));
};

export const getMyTicket: GetMyTicket = async (userId, ticketId) => {
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return err('not_found', 'ticket not found');
  const { db, supportTickets: t, supportMessages: m } = await dbm();
  const [r] = await db.select(pick(t, 'id', 'number', 'type', 'subject', 'status', 'createdAt', 'lastAdminReplyAt', 'lastUserReadAt', 'lastUserMessageAt', 'context', 'resolvedAt')).from(t).where(and(eq(t.id, ticketId), eq(t.userId, userId)));
  if (!r) return err('not_found', 'ticket not found'); // another user's ticket looks the same
  const msgs = await db.select(pick(m, 'id', 'authorType', 'body', 'createdAt')).from(m).where(and(eq(m.ticketId, ticketId), eq(m.internal, false))).orderBy(asc(m.createdAt));
  const files = await attachmentsOf(ticketId);
  return ok({
    id: r.id, number: r.number, type: r.type, subject: r.subject, status: r.status, unread: isUnread(r), createdAt: r.createdAt,
    updatedAt: r.lastAdminReplyAt && r.lastAdminReplyAt > r.lastUserMessageAt ? r.lastAdminReplyAt : r.lastUserMessageAt,
    context: r.context ?? null,
    reopenableUntil: r.resolvedAt ? new Date(r.resolvedAt.getTime() + SUPPORT_LIMITS.reopenDays * DAY) : null,
    messages: msgs.map((x) => ({ id: x.id, authorType: x.authorType, body: x.body, createdAt: x.createdAt, attachments: files.filter((f) => f.messageId === x.id).map((f) => ({ id: f.id, mime: f.mime, sizeBytes: f.sizeBytes, url: f.url })) })),
  } satisfies SupportTicketDetail);
};

export const replyToTicket: ReplyToTicket = async (userId, ticketId, input) => {
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return err('not_found', 'ticket not found');
  const { db, supportTickets: t, supportMessages: m } = await dbm();
  const files = await processAttachments(userId, input.attachments ?? []);
  if (!files.ok) return files;
  const r = await db.transaction(async (tx) => {
    const [row] = await tx.select(pick(t, 'status', 'resolvedAt')).from(t).where(and(eq(t.id, ticketId), eq(t.userId, userId))).for('update');
    if (!row) return err('not_found', 'ticket not found');
    if (row.status === 'resolved' && row.resolvedAt && Date.now() - row.resolvedAt.getTime() > SUPPORT_LIMITS.reopenDays * DAY) return err('conflict', supportErrors.closed);
    const [msg] = await tx.insert(m).values({ ticketId, authorType: 'user', body: input.body }).returning({ id: m.id });
    await insertAttachments(tx, ticketId, msg!.id, files.data);
    await tx.update(t).set({ status: row.status === 'in_review' ? 'in_review' : 'open', resolvedAt: null, lastUserMessageAt: new Date(), updatedAt: new Date() }).where(eq(t.id, ticketId));
    return ok(null);
  });
  if (!r.ok) {
    await dropFiles(files.data);
    return r;
  }
  await invalidate('support.changed', { userId });
  return getMyTicket(userId, ticketId);
};

export const markTicketRead: MarkTicketRead = async (userId, ticketId) => {
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return err('not_found', 'ticket not found');
  const { db, supportTickets: t } = await dbm();
  const u = await db.update(t).set({ lastUserReadAt: new Date() }).where(and(eq(t.id, ticketId), eq(t.userId, userId))).returning({ id: t.id });
  if (!u.length) return err('not_found', 'ticket not found');
  await invalidate('support.changed', { userId });
  return ok(null);
};

export const getSupportUnread: GetSupportUnread = async (userId) => {
  const { db, supportTickets: t } = await dbm();
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(and(eq(t.userId, userId), isNotNull(t.lastAdminReplyAt), sql`${t.lastAdminReplyAt} > coalesce(${t.lastUserReadAt}, '-infinity')`));
  return ok({ count: r!.n });
};
