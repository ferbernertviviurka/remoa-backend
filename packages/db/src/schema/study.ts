import { sql } from 'drizzle-orm';
import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  index('fsrs_state_card_idx').on(t.cardId), // G21 FR-26 (0033): FK cascade from cards (PK starts with user_id)
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
}, (t) => [index('sessions_user_started_idx').on(t.userId, t.startedAt.desc())]); // G21 FR-26 (0033): onboarding.ts:20, inactivity.ts:23

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
  // G21 FR-26 (0033): FK cascade from cards / set null from sessions
  index('attempts_card_idx').on(t.cardId),
  index('attempts_session_idx').on(t.sessionId).where(sql`${t.sessionId} is not null`),
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
}, (t) => [index('review_queue_card_idx').on(t.cardId)]); // G21 FR-26 (0033): editorial.ts:95-110 join, FK cascade

export const imports = pgTable('imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  kind: importKindEnum('kind').notNull(),
  status: jobStatusEnum('status').notNull().default('queued'),
  stats: jsonb('stats'),
  error: text('error'),
  ...timestamps,
}, (t) => [index('imports_user_status_idx').on(t.userId, t.status)]); // G21 FR-26 (0033): imports.ts:147, quota.ts:61

/**
 * G21 FR-23 / CCR-055 (D-1029): per (user, board) totals for the lists, Hoje, Revisar and coverage, so no read counts cards.
 * Kept by triggers (0034) in the same transaction as every write that changes them (cards, edges, fsrs_state): the row is marked
 * stale (`stale_at` null, `version` + 1) and the next reader recomputes that one board (apps/api/src/review/stats.ts, `mapStatsFor`).
 * Recall states drift with the clock, so a computed row is valid while `day_end` is the reader's study-day end and now < `stale_at`
 * (the next moment any card of the board changes state). Scope = the daily queue's: own board -> all live cards; another's -> cards with state.
 */
export const mapStats = pgTable('map_stats', {
  userId: userId(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  cards: integer('cards').notNull().default(0), // live, non-note, in scope (suspended included, as on the map)
  notes: integer('notes').notNull().default(0),
  edges: integer('edges').notNull().default(0), // both ends live
  review: integer('review').notNull().default(0),
  watch: integer('watch').notNull().default(0),
  steady: integer('steady').notNull().default(0),
  unknown: integer('unknown').notNull().default(0),
  due: integer('due').notNull().default(0), // active items due before day_end (the queue's `due`)
  reviewed: integer('reviewed').notNull().default(0), // cards with a state other than unknown
  rSum: doublePrecision('r_sum').notNull().default(0), // sum of their recall at compute time (coverage average)
  dayEnd: timestamp('day_end', { withTimezone: true }),
  staleAt: timestamp('stale_at', { withTimezone: true }),
  version: integer('version').notNull().default(0),
  ...timestamps,
}, (t) => [
  primaryKey({ columns: [t.userId, t.boardId] }),
  index('map_stats_board_idx').on(t.boardId), // the cards/edges triggers mark every reader of a board
]);

/** G21 FR-23 / CCR-055: attempts per study day (profile tz, 04:00 rollover), kept by triggers on `attempts` (0034). */
export const userDailyStats = pgTable('user_daily_stats', {
  userId: userId(),
  day: date('day').notNull(),
  reviews: integer('reviews').notNull().default(0),
  hits: integer('hits').notNull().default(0), // grade >= 3
  timeMs: bigint('time_ms', { mode: 'number' }).notNull().default(0),
  ...timestamps,
}, (t) => [primaryKey({ columns: [t.userId, t.day] })]);
