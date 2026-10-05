import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  editorialStatusEnum, flagSourceEnum, fsrsStateEnum, importKindEnum, inputKindEnum, jobStatusEnum, modeEnum,
  sessionKindEnum, timestamps, userId, authUsers,
} from './common';
import { boards, cards } from './content';

export const fsrsState = pgTable('fsrs_state', {
  userId: userId(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  subId: text('sub_id').notNull().default(''), // '' = card itself; step/mask id otherwise
  stability: doublePrecision('stability').notNull().default(0),
  difficulty: doublePrecision('difficulty').notNull().default(0),
  due: timestamp('due', { withTimezone: true }).notNull(),
  reps: integer('reps').notNull().default(0),
  lapses: integer('lapses').notNull().default(0),
  lastReview: timestamp('last_review', { withTimezone: true }),
  state: fsrsStateEnum('state').notNull().default('new'),
  learningSteps: integer('learning_steps').notNull().default(0), // ts-fsrs short-term step (D-056)
  scheduledDays: integer('scheduled_days').notNull().default(0),
  ...timestamps,
}, (t) => [
  primaryKey({ columns: [t.userId, t.cardId, t.subId] }),
  index('fsrs_state_user_due_idx').on(t.userId, t.due),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  boardId: uuid('board_id').references(() => boards.id, { onDelete: 'set null' }),
  kind: sessionKindEnum('kind').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  items: jsonb('items').notNull().default([]),
  /** CCR-019 (D-575): ChallengeOptions as applied at start ({} = DEFAULT_CHALLENGE_OPTIONS; read through challengeOptionsSchema). */
  options: jsonb('options').notNull().default({}),
  ...timestamps,
});

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  subId: text('sub_id').notNull().default(''),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  mode: modeEnum('mode').notNull(),
  inputKind: inputKindEnum('input_kind').notNull(),
  answerText: text('answer_text'),
  verdict: jsonb('verdict'),
  grade: integer('grade').notNull(), // 1..4
  gradeOverridden: boolean('grade_overridden').notNull().default(false),
  durationMs: integer('duration_ms'),
  ...timestamps,
}, (t) => [
  index('attempts_user_card_idx').on(t.userId, t.cardId),
  index('attempts_user_created_idx').on(t.userId, t.createdAt),
  index('attempts_user_card_created_idx').on(t.userId, t.cardId, t.createdAt),
]);

export const reviewQueue = pgTable('review_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  status: editorialStatusEnum('status').notNull().default('pending'),
  reviewerId: uuid('reviewer_id').references(() => authUsers.id),
  note: text('note'),
  flagSource: flagSourceEnum('flag_source'),
  attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }), // F04 dispute → F10
  ...timestamps,
});

export const imports = pgTable('imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  kind: importKindEnum('kind').notNull(),
  status: jobStatusEnum('status').notNull().default('queued'),
  stats: jsonb('stats'),
  error: text('error'),
  ...timestamps,
});
