// F19 Suporte (CCR-011, D-425–D-427). RLS and column grants in migrations/0021_f19_support_admin.sql (hand-appended).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { supportAuthorTypes, supportTicketStatuses, supportTicketTypes, type SupportContext } from '@remoa/contracts';
import { authUsers, timestamps, userId } from './common';

export const supportTicketTypeEnum = pgEnum('support_ticket_type', supportTicketTypes);
export const supportTicketStatusEnum = pgEnum('support_ticket_status', supportTicketStatuses);
export const supportAuthorTypeEnum = pgEnum('support_author_type', supportAuthorTypes);

/** Deleted with the account (cascade, FR-9). `number` is global and shown as "#1042". */
export const supportTickets = pgTable('support_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: integer('number').notNull().unique().generatedAlwaysAsIdentity({ startWith: 1001 }),
  userId: userId(),
  type: supportTicketTypeEnum('type').notNull(),
  subject: text('subject').notNull(),
  status: supportTicketStatusEnum('status').notNull().default('open'),
  assignedTo: uuid('assigned_to').references(() => authUsers.id, { onDelete: 'set null' }),
  /** supportContextSchema (strict whitelist, FR-4); null = the user turned it off. */
  context: jsonb('context').$type<SupportContext>(),
  lastUserMessageAt: timestamp('last_user_message_at', { withTimezone: true }).notNull().default(sql`now()`),
  lastAdminReplyAt: timestamp('last_admin_reply_at', { withTimezone: true }),
  /** unread = last_admin_reply_at > coalesce(last_user_read_at, '-infinity'). */
  lastUserReadAt: timestamp('last_user_read_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  // "Meus chamados", per-user rate limit (5/h, 20/day) and duplicate check.
  index('support_tickets_user_idx').on(t.userId, t.createdAt.desc()),
  // Inbox: filter by status, oldest unanswered first / newest first.
  index('support_tickets_status_idx').on(t.status, t.lastUserMessageAt.desc()),
  index('support_tickets_subject_trgm_idx').using('gin', t.subject.op('gin_trgm_ops')),
  check('support_tickets_subject', sql`char_length(${t.subject}) between 5 and 120`),
  check('support_tickets_resolved', sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`),
]);

/** Append-only by convention (no UPDATE/DELETE route; FR-7). `internal` = admin note, never visible to the user. */
export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => supportTickets.id, { onDelete: 'cascade' }),
  authorType: supportAuthorTypeEnum('author_type').notNull(),
  /** null for `system`; admin account deleted → null (the message stays). */
  authorId: uuid('author_id').references(() => authUsers.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  internal: boolean('internal').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('support_messages_ticket_idx').on(t.ticketId, t.createdAt),
  check('support_messages_body', sql`char_length(${t.body}) between 1 and 5000`),
  check('support_messages_internal', sql`not ${t.internal} or ${t.authorType} = 'admin'`),
]);

/** Private storage object `support/<userId>/<uuid>` (EXIF stripped). Deleted 90 days after resolution (Q-046). */
export const supportAttachments = pgTable('support_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => supportTickets.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').notNull().references(() => supportMessages.id, { onDelete: 'cascade' }),
  key: text('key').notNull().unique(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('support_attachments_message_idx').on(t.messageId),
  index('support_attachments_ticket_idx').on(t.ticketId),
  check('support_attachments_mime', sql`${t.mime} in ('image/png', 'image/jpeg')`),
  check('support_attachments_size', sql`${t.size} between 1 and 5242880`),
]);
