import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, real, smallint, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  ALTERNATIVE_KEYS, aiItemTypes, cardRubricStatuses, challengeFormats, challengeItemKinds, challengeSessionStatuses, enamedTaxonomyKinds,
  gradedBy, grades, questionDifficulties, questionSources, questionStatuses, questionTypes, summaryFocuses, summarySizes, verdicts,
  type AiAnswerInput, type AiChallengeItemPublic, type ChallengeConfig, type ChallengeScope, type QuestionEvidence, type QuestionStats,
  type ReferenceRef, type ShuffleMap, type SummarySection,
} from '@remoa/contracts';
import { areaEnum, timestamps, userId } from './common';
import { boards, cards, matrixItems } from './content';

// F30 (G25, CCR-090, D-1600–D-1610). RLS, grants and the append-only trigger are hand-written in 0041. Reference material
// (correct_key, expected_answer, key_points, explanation, distractor_notes, card_rubrics, reference_ref, shuffle_map) has no
// SELECT grant for `authenticated`: the API reads it with the server connection (asServer) and never sends it before grading (FR-36).

/** `col in ('a','b')`: text columns typed by a contracts tuple, checked in the database. */
const oneOf = (col: AnyPgColumn, values: readonly string[]): SQL => sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

/** D-1604: ENAMED taxonomy, derived from matrix_items (seed/enamed-taxonomy.ts). Public read; no user_id. */
export const enamedTaxonomy = pgTable('enamed_taxonomy', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Area rows: the area enum value ('CM'); others: the matrix_items code. */
  code: text('code').notNull().unique(),
  kind: text('kind', { enum: enamedTaxonomyKinds }).notNull(),
  area: areaEnum('area').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => enamedTaxonomy.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** null on area rows (the matrix has no area row). */
  matrixRef: uuid('matrix_ref').unique().references(() => matrixItems.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  index('enamed_taxonomy_parent_idx').on(t.parentId),
  check('enamed_taxonomy_kind_chk', oneOf(t.kind, enamedTaxonomyKinds)),
  check('enamed_taxonomy_root_chk', sql`(${t.kind} = 'area') = (${t.parentId} is null)`),
]);

/** FR-16 / D-1602: private question bank (owner only; no shared bank). Editing creates a new row (`supersedes_id`). */
export const questionBank = pgTable('question_bank', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  boardId: uuid('board_id').references(() => boards.id, { onDelete: 'cascade' }),
  boardVersion: integer('board_version'),
  cardIds: uuid('card_ids').array().notNull().default(sql`'{}'::uuid[]`),
  type: text('type', { enum: questionTypes }).notNull(),
  difficulty: text('difficulty', { enum: questionDifficulties }).notNull(),
  stem: text('stem').notNull(),
  /** [{ key: 'A'..'D', text }] in stored order; null for discursive. */
  alternatives: jsonb('alternatives').$type<{ key: (typeof ALTERNATIVE_KEYS)[number]; text: string }[]>(),
  correctKey: text('correct_key', { enum: ALTERNATIVE_KEYS }),
  expectedAnswer: text('expected_answer').notNull(),
  keyPoints: text('key_points').array().notNull().default(sql`'{}'::text[]`),
  explanation: text('explanation'),
  distractorNotes: jsonb('distractor_notes').$type<Partial<Record<(typeof ALTERNATIVE_KEYS)[number], string>>>(),
  evidences: jsonb('evidences').$type<QuestionEvidence[]>().notNull().default([]),
  enamedAreaId: uuid('enamed_area_id').references(() => enamedTaxonomy.id, { onDelete: 'set null' }),
  enamedDomainId: uuid('enamed_domain_id').references(() => enamedTaxonomy.id, { onDelete: 'set null' }),
  enamedCompetencyId: uuid('enamed_competency_id').references(() => enamedTaxonomy.id, { onDelete: 'set null' }),
  enamedTopicId: uuid('enamed_topic_id').references(() => enamedTaxonomy.id, { onDelete: 'set null' }),
  enamedConfidence: real('enamed_confidence'),
  enamedConfirmed: boolean('enamed_confirmed').notNull().default(false),
  source: text('source', { enum: questionSources }).notNull(),
  promptId: text('prompt_id'),
  promptVersion: text('prompt_version'),
  model: text('model'),
  status: text('status', { enum: questionStatuses }).notNull().default('draft'),
  stats: jsonb('stats').$type<QuestionStats>().notNull().default({ seen: 0, correct: 0, partial: 0, incorrect: 0 }),
  version: integer('version').notNull().default(1),
  supersedesId: uuid('supersedes_id').references((): AnyPgColumn => questionBank.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  index('question_bank_user_board_created_idx').on(t.userId, t.boardId, t.createdAt.desc()),
  index('question_bank_user_topic_idx').on(t.userId, t.enamedTopicId),
  index('question_bank_board_idx').on(t.boardId),
  index('question_bank_supersedes_idx').on(t.supersedesId).where(sql`${t.supersedesId} is not null`),
  check('question_bank_type_chk', oneOf(t.type, questionTypes)),
  check('question_bank_difficulty_chk', oneOf(t.difficulty, questionDifficulties)),
  check('question_bank_source_chk', oneOf(t.source, questionSources)),
  check('question_bank_status_chk', oneOf(t.status, questionStatuses)),
  check('question_bank_correct_key_chk', sql`${t.correctKey} is null or ${oneOf(t.correctKey, ALTERNATIVE_KEYS)}`),
  check('question_bank_objective_chk', sql`(${t.type} = 'objective') = (${t.correctKey} is not null and ${t.alternatives} is not null)`),
  check('question_bank_alternatives_chk', sql`${t.alternatives} is null or (jsonb_typeof(${t.alternatives}) = 'array' and jsonb_array_length(${t.alternatives}) = 4)`),
  check('question_bank_evidences_chk', sql`jsonb_typeof(${t.evidences}) = 'array'`),
  check('question_bank_confidence_chk', sql`${t.enamedConfidence} is null or ${t.enamedConfidence} between 0 and 1`),
]);

/** FR-37: server-side session, fixed order, one open item (`position`), expires (CHALLENGE_SESSION_TTL_MIN). Not F04's `sessions`. */
export const challengeSessions = pgTable('challenge_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  boardId: uuid('board_id').references(() => boards.id, { onDelete: 'set null' }),
  scope: jsonb('scope').$type<ChallengeScope>().notNull(),
  format: text('format', { enum: challengeFormats }).notNull(),
  params: jsonb('params').$type<ChallengeConfig>().notNull(),
  status: text('status', { enum: challengeSessionStatuses }).notNull().default('active'),
  /** The item that accepts an answer now (challenge_items.position). */
  position: integer('position').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  score: jsonb('score').$type<{ correct: number; partial: number; incorrect: number; pending: number }>(),
  /** D-1567: study advice written once at finish when the score is under 70% (cards and maps by id, reasons). Server-owned. */
  recommendations: jsonb('recommendations'),
  ...timestamps,
}, (t) => [
  unique('challenge_sessions_id_user_uq').on(t.id, t.userId),
  index('challenge_sessions_user_started_idx').on(t.userId, t.startedAt.desc()),
  index('challenge_sessions_board_idx').on(t.boardId),
  check('challenge_sessions_format_chk', oneOf(t.format, challengeFormats)),
  check('challenge_sessions_status_chk', oneOf(t.status, challengeSessionStatuses)),
]);

/** FR-36/FR-37. `payload_public` = AiChallengeItemPublic; `reference_ref` and `shuffle_map` are server-only (no column grant). */
export const challengeItems = pgTable('challenge_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull(),
  userId: userId(),
  position: integer('position').notNull(),
  kind: text('kind', { enum: challengeItemKinds }).notNull(),
  cardId: uuid('card_id').references(() => cards.id, { onDelete: 'set null' }),
  subId: text('sub_id').notNull().default(''),
  bankId: uuid('bank_id').references(() => questionBank.id, { onDelete: 'set null' }),
  type: text('type', { enum: aiItemTypes }).notNull(),
  payloadPublic: jsonb('payload_public').$type<AiChallengeItemPublic>().notNull(),
  referenceRef: jsonb('reference_ref').$type<ReferenceRef>().notNull(),
  shuffleMap: jsonb('shuffle_map').$type<ShuffleMap>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  foreignKey({ name: 'challenge_items_session_user_fk', columns: [t.sessionId, t.userId], foreignColumns: [challengeSessions.id, challengeSessions.userId] })
    .onDelete('cascade'),
  unique('challenge_items_session_position_uq').on(t.sessionId, t.position),
  unique('challenge_items_id_user_uq').on(t.id, t.userId),
  index('challenge_items_card_idx').on(t.cardId).where(sql`${t.cardId} is not null`),
  index('challenge_items_bank_idx').on(t.bankId).where(sql`${t.bankId} is not null`),
  check('challenge_items_kind_chk', oneOf(t.kind, challengeItemKinds)),
  check('challenge_items_type_chk', oneOf(t.type, aiItemTypes)),
]);

/**
 * FR-38: append-only (trigger + no UPDATE/DELETE grant). A pending answer (FR-35) is a row with `graded_by = 'pending'`; its grade
 * is a new row with the same `attempt_no`. The only allowed UPDATE flips `disputed` false -> true (server connection, FR-39).
 * Cascaded deletes (session/account removal, LGPD) pass; a direct DELETE does not.
 */
export const challengeAttempts = pgTable('challenge_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull(),
  userId: userId(),
  attemptNo: smallint('attempt_no').notNull(),
  answer: jsonb('answer').$type<AiAnswerInput>().notNull(),
  answerHash: text('answer_hash').notNull(),
  verdict: text('verdict', { enum: verdicts }),
  covered: text('covered').array().notNull().default(sql`'{}'::text[]`),
  missing: text('missing').array().notNull().default(sql`'{}'::text[]`),
  criticalError: boolean('critical_error').notNull().default(false),
  manipulation: boolean('manipulation').notNull().default(false),
  feedback: text('feedback'),
  hint: text('hint'),
  usedHint: boolean('used_hint').notNull().default(false),
  confidence: real('confidence'),
  gradedBy: text('graded_by', { enum: gradedBy }).notNull(),
  model: text('model'),
  promptVersion: text('prompt_version'),
  latencyMs: integer('latency_ms'),
  /** D-1567: time the student took on this attempt (client clock, capped at 1 h); only on the pending row. */
  elapsedMs: integer('elapsed_ms'),
  rating: text('rating', { enum: grades }),
  disputed: boolean('disputed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  foreignKey({ name: 'challenge_attempts_item_user_fk', columns: [t.itemId, t.userId], foreignColumns: [challengeItems.id, challengeItems.userId] })
    .onDelete('cascade'),
  uniqueIndex('challenge_attempts_graded_uq').on(t.itemId, t.attemptNo).where(sql`${t.gradedBy} <> 'pending'`),
  uniqueIndex('challenge_attempts_pending_uq').on(t.itemId, t.attemptNo).where(sql`${t.gradedBy} = 'pending'`),
  index('challenge_attempts_item_idx').on(t.itemId), // FK cascade from challenge_items (the uniques are partial)
  index('challenge_attempts_user_created_idx').on(t.userId, t.createdAt),
  check('challenge_attempts_no_chk', sql`${t.attemptNo} between 1 and 2`),
  check('challenge_attempts_graded_by_chk', oneOf(t.gradedBy, gradedBy)),
  check('challenge_attempts_verdict_chk', sql`(${t.verdict} is null) = (${t.gradedBy} = 'pending') and (${t.verdict} is null or ${oneOf(t.verdict, verdicts)})`),
  check('challenge_attempts_rating_chk', sql`${t.rating} is null or ${oneOf(t.rating, grades)}`),
  check('challenge_attempts_confidence_chk', sql`${t.confidence} is null or ${t.confidence} between 0 and 1`),
]);

/** FR-26: one rubric per card content (`card_hash`, cards have no version column). Server-only (reference material). */
export const cardRubrics = pgTable('card_rubrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  /** sha256 of the card fields the rubric derives from (front, back, didactics.porQue), computed by the server. */
  cardHash: text('card_hash').notNull(),
  essentialPoints: text('essential_points').array().notNull(),
  acceptedVariants: text('accepted_variants').array().notNull().default(sql`'{}'::text[]`),
  criticalErrors: text('critical_errors').array().notNull().default(sql`'{}'::text[]`),
  status: text('status', { enum: cardRubricStatuses }).notNull().default('auto'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  ...timestamps,
}, (t) => [
  unique('card_rubrics_card_hash_uq').on(t.cardId, t.cardHash),
  check('card_rubrics_status_chk', oneOf(t.status, cardRubricStatuses)),
]);

/** FR-50: per board version, history (last 5 kept by the service), `stale` when the map changed. */
export const mapSummaries = pgTable('map_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  boardVersion: integer('board_version').notNull(),
  size: text('size', { enum: summarySizes }).notNull(),
  focus: text('focus', { enum: summaryFocuses }).notNull(),
  content: jsonb('content').$type<SummarySection[]>().notNull(),
  cardsCited: uuid('cards_cited').array().notNull().default(sql`'{}'::uuid[]`),
  model: text('model'),
  promptVersion: text('prompt_version'),
  stale: boolean('stale').notNull().default(false),
  ...timestamps,
}, (t) => [
  index('map_summaries_user_board_created_idx').on(t.userId, t.boardId, t.createdAt.desc()),
  index('map_summaries_board_idx').on(t.boardId),
  check('map_summaries_size_chk', oneOf(t.size, summarySizes)),
  check('map_summaries_focus_chk', oneOf(t.focus, summaryFocuses)),
  check('map_summaries_content_chk', sql`jsonb_typeof(${t.content}) = 'array'`),
]);
