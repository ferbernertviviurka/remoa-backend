import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  areaEnum, authUsers, boardStatusEnum, cardShapeEnum, cardStatusEnum, cardTypeEnum, licenseEnum, roleEnum, timestamps, userId,
} from './common';

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  name: text('name'),
  role: roleEnum('role').notNull().default('student'),
  school: text('school'),
  year: integer('year'),
  goal: text('goal'),
  /** F13: y3_4 | y5_6 | graduated (stageSchema). */
  stage: text('stage'),
  /** F13: processed 512 px WebP key; server-owned (no GRANT to authenticated). */
  avatarKey: text('avatar_key'),
  avatarColor: smallint('avatar_color').notNull().default(0),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  onboardingDoneAt: timestamp('onboarding_done_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [check('profiles_avatar_color', sql`${t.avatarColor} between 0 and 4`)]);

export const matrixItems = pgTable('matrix_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  area: areaEnum('area').notNull(),
  code: text('code').notNull().unique(),
  title: text('title').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => matrixItems.id),
  targetCards: integer('target_cards').notNull().default(40),
  /** F07: edital version the item was transcribed from (e.g. 'INEP Enamed 2025'). */
  temporalMark: text('temporal_mark'),
  ...timestamps,
});

export const boards = pgTable('boards', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  title: text('title').notNull(),
  area: areaEnum('area').notNull().default('CM'),
  matrixItemId: uuid('matrix_item_id').references(() => matrixItems.id),
  status: boardStatusEnum('status').notNull().default('private'),
  version: integer('version').notNull().default(1),
  temporalMark: text('temporal_mark'),
  reviewerId: uuid('reviewer_id').references(() => authUsers.id),
  sourceBoardId: uuid('source_board_id').references((): AnyPgColumn => boards.id, { onDelete: 'set null' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }), // F01: hidden from "Meus mapas"
  ...timestamps,
}, (t) => [index('boards_user_idx').on(t.userId)]);

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: userId(),
  key: text('key').notNull(),
  mime: text('mime').notNull(),
  width: integer('width'),
  height: integer('height'),
  license: licenseEnum('license').notNull().default('own'),
  attribution: text('attribution'),
  ...timestamps,
});

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  type: cardTypeEnum('type').notNull().default('concept'),
  shape: cardShapeEnum('shape').notNull().default('rect'),
  title: text('title').notNull(),
  front: text('front'),
  frontAssetId: uuid('front_asset_id').references(() => assets.id, { onDelete: 'set null' }),
  back: text('back'),
  payload: jsonb('payload').notNull().default({}),
  rubric: jsonb('rubric'),
  source: text('source'),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  status: cardStatusEnum('status').notNull().default('draft'),
  order: integer('order').notNull().default(0),
  reviewerId: uuid('reviewer_id').references(() => authUsers.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // F01: soft delete, 30 days
  ...timestamps,
}, (t) => [index('cards_board_idx').on(t.boardId)]);

export const edges = pgTable('edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  fromCardId: uuid('from_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  toCardId: uuid('to_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  label: text('label'),
  question: text('question'),
  ...timestamps,
}, (t) => [index('edges_board_idx').on(t.boardId)]);

export const masks = pgTable('masks', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }), // account deletion (F08) removes assets
  polygon: jsonb('polygon').notNull(),
  label: text('label'),
  ...timestamps,
});

export const boardMatrixItems = pgTable('board_matrix_items', {
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  matrixItemId: uuid('matrix_item_id').notNull().references(() => matrixItems.id, { onDelete: 'cascade' }),
  ...timestamps,
}, (t) => [primaryKey({ columns: [t.boardId, t.matrixItemId] })]);

export const boardVersions = pgTable('board_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  changelog: text('changelog'),
  snapshot: jsonb('snapshot').notNull(),
  reviewerId: uuid('reviewer_id').references(() => authUsers.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  ...timestamps,
});


