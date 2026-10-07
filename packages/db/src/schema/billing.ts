import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { jobStatusEnum, planEnum, subStatusEnum, timestamps, userId } from './common';
import { boards } from './content';

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
  /** G22 (D-1412): rubric drafts, own counter (was sharing ai_grades); same daily number as ai_grades in PlanDefinition. */
  aiRubrics: integer('ai_rubrics').notNull().default(0),
  /** F30 (D-1601): generated question batches (per local day) and map summaries (rows on the 1st of the month). */
  aiQuestionBatches: integer('ai_question_batches').notNull().default(0),
  aiSummaries: integer('ai_summaries').notNull().default(0),
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
  promptVersion: text('prompt_version').notNull().default('legacy'),
  ...timestamps,
});

/** G22 (D-1416): "Essa correção está errada". One row per graded call, never the answer text; the call row has model and prompt version. */
export const aiGradeFlags = pgTable('ai_grade_flags', {
  callId: uuid('call_id').primaryKey().references(() => aiCalls.id, { onDelete: 'cascade' }),
  userId: userId(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * G22 (D-1415): map generation jobs (text/PDF), state in Postgres so Inngest (any process) runs them and /jobs/:id reads them.
 * `text` = the input, kept only while the job can still run or be retried (cleared on done and cancel). Cancel = failed + error 'canceled'.
 * `charged` = a unit of ai_generations is held for `quota_period` (given back exactly once on failure).
 */
export const aiJobs = pgTable('ai_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  kind: text('kind').notNull(), // 'text' | 'pdf'
  status: jobStatusEnum('status').notNull().default('queued'),
  stage: text('stage'),
  progress: integer('progress').notNull().default(0),
  input: jsonb('input').notNull(),
  text: text('text'),
  inputHash: text('input_hash').notNull(),
  boardId: uuid('board_id').references(() => boards.id, { onDelete: 'set null' }),
  error: text('error'),
  ai: jsonb('ai'),
  stats: jsonb('stats'),
  charged: boolean('charged').notNull().default(false),
  quotaPeriod: date('quota_period', { mode: 'string' }),
  attempts: integer('attempts').notNull().default(0),
  ...timestamps,
}, (t) => [index('ai_jobs_user_hash_idx').on(t.userId, t.inputHash)]);

export const waitlist = pgTable('waitlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  segment: text('segment'),
  variant: text('variant'),
  source: text('source'),
  ...timestamps,
});

