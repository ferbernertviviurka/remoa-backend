// F19 Painel admin (CCR-011, D-428–D-430). RLS, REVOKEs and the append-only trigger in migrations/0017_f19_support_admin.sql.
import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, check } from 'drizzle-orm/pg-core';
import { auditActorTypes, auditResults, paymentStatuses, type PaymentEventType } from '@remoa/contracts';
import { authUsers } from './common';

export const paymentStatusEnum = pgEnum('payment_status', paymentStatuses);
export const auditActorTypeEnum = pgEnum('audit_actor_type', auditActorTypes);
export const auditResultEnum = pgEnum('audit_result', auditResults);

/**
 * Mirror of Stripe charges, written only by the webhook (idempotent upsert by id; D-428).
 * `id` = PaymentIntent id, or invoice id when there is none. Survives account deletion (user_id set null).
 */
export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePaymentIntent: text('stripe_payment_intent'),
  stripeInvoiceId: text('stripe_invoice_id'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('brl'),
  /** paymentRecordMethods: pix | card | credit */
  method: text('method').notNull(),
  status: paymentStatusEnum('status').notNull(),
  /** paymentItems: pro_monthly | pro_annual | founder_lifetime */
  item: text('item').notNull(),
  coupon: text('coupon'),
  /** FR-16 drawer timeline, appended by the webhook: [{ type, at }]. */
  events: jsonb('events').$type<{ type: PaymentEventType; at: string }[]>().notNull().default([]),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('payments_created_idx').on(t.createdAt.desc()),
  index('payments_user_idx').on(t.userId, t.createdAt.desc()),
  index('payments_status_idx').on(t.status, t.createdAt.desc()),
  check('payments_amount', sql`${t.amountCents} >= 0`),
  check('payments_method', sql`${t.method} in ('pix', 'card', 'credit')`),
  check('payments_refunded', sql`(${t.status} = 'refunded') = (${t.refundedAt} is not null)`),
]);

/**
 * Append-only (trigger blocks UPDATE/DELETE/TRUNCATE for every role; D-429). No FK on actor/target: the log must outlive
 * the accounts it mentions. `id` is shown as "a_1050".
 */
export const adminAuditLog = pgTable('admin_audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity({ startWith: 1001 }),
  actorType: auditActorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id'),
  /** adminActions (contracts) */
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  reason: text('reason'),
  result: auditResultEnum('result').notNull(),
  /** auditDenials, only when result = denied */
  denial: text('denial'),
  before: jsonb('before'),
  after: jsonb('after'),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('admin_audit_log_created_idx').on(t.createdAt.desc()),
  index('admin_audit_log_actor_idx').on(t.actorId, t.createdAt.desc()),
  index('admin_audit_log_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),
  index('admin_audit_log_action_idx').on(t.action, t.createdAt.desc()),
  check('admin_audit_log_denial', sql`(${t.result} = 'denied') = (${t.denial} is not null)`),
  // Rule 9: a successful admin action always has a reason of at least 8 characters.
  check('admin_audit_log_reason', sql`${t.actorType} <> 'admin' or ${t.result} <> 'success' or char_length(btrim(${t.reason})) >= 8`),
]);

/** One row per day (America/Sao_Paulo), upserted by the metrics job (T4). Overview reads sums over the period. */
export const adminMetricsDaily = pgTable('admin_metrics_daily', {
  day: date('day', { mode: 'string' }).primaryKey(),
  newAccounts: integer('new_accounts').notNull().default(0),
  newMaps: integer('new_maps').notNull().default(0),
  newPro: integer('new_pro').notNull().default(0),
  revenueCents: bigint('revenue_cents', { mode: 'number' }).notNull().default(0),
  referralsQualified: integer('referrals_qualified').notNull().default(0),
  ticketsOpened: integer('tickets_opened').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});
