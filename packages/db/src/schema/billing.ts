import { boolean, date, integer, pgTable, text, timestamp, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { planEnum, subStatusEnum, timestamps, userId } from './common';

export const subscriptions = pgTable('subscriptions', {
  userId: userId().primaryKey(),
  plan: planEnum('plan').notNull().default('free'),
  status: subStatusEnum('status').notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  renewsAt: timestamp('renews_at', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  ...timestamps,
});

/** F08 FR-2: processed Stripe event ids (webhook idempotency). Server-only, no user policy. */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  ...timestamps,
});

export const usageCounters = pgTable('usage_counters', {
  userId: userId(),
  period: date('period', { mode: 'string' }).notNull(), // YYYY-MM-DD
  aiGrades: integer('ai_grades').notNull().default(0),
  aiGenerations: integer('ai_generations').notNull().default(0),
  boards: integer('boards').notNull().default(0),
  cards: integer('cards').notNull().default(0),
  ...timestamps,
}, (t) => [primaryKey({ columns: [t.userId, t.period] })]);

export const aiCalls = pgTable('ai_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costCents: integer('cost_cents').notNull().default(0),
  latencyMs: integer('latency_ms'),
  ...timestamps,
});

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  segment: text('segment'),
  variant: text('variant'),
  source: text('source'),
  ...timestamps,
});

