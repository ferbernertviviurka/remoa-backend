import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  areaEnum, authUsers, boardAccessEnum, boardStatusEnum, cardShapeEnum, cardStatusEnum, cardTypeEnum, licenseEnum, roleEnum, timestamps, userId,
} from './common';

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  name: text('name'),
  role: roleEnum('role').notNull().default('student'),
  school: text('school'),
  year: integer('year'),
  goal: text('goal'),
  /** F10: council registration stamped on approved rubrics. */
  crm: text('crm'),
  /** F13: y3_4 | y5_6 | graduated (stageSchema). */
  stage: text('stage'),
  /** F13: processed 512 px WebP key; server-owned (no GRANT to authenticated). */
  avatarKey: text('avatar_key'),
  avatarColor: smallint('avatar_color').notNull().default(0),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  onboardingDoneAt: timestamp('onboarding_done_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** F18: who referred this user (first touch, D-383). Server-owned (no column GRANT). */
  referredBy: uuid('referred_by').references(() => authUsers.id, { onDelete: 'set null' }),
  /** F19: set by the admin (withAdmin 'user.suspend'); blocks every /v1/* call. Server-owned (no column GRANT). */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedReason: text('suspended_reason'),
  ...timestamps,
}, (t) => [
  check('profiles_avatar_color', sql`${t.avatarColor} between 0 and 4`),
  check('profiles_suspended', sql`(${t.suspendedAt} is null) = (${t.suspendedReason} is null)`),
  // F19 admin search by name (ILIKE).
  index('profiles_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
]);

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
  // F17 sharing (D-285–D-289). Written only by the server connection (no UPDATE grant to authenticated on these columns).
  access: boardAccessEnum('access').notNull().default('owner'),
  shareToken: text('share_token').unique(), // 32 random bytes, base64url; never logged
  sharePasswordHash: text('share_password_hash'), // `scrypt$v1$<salt>$<key>`; never returned, not even to the owner
  shareSecretVersion: integer('share_secret_version').notNull().default(1), // bumped on every access change, rotate or new password
  sharedAt: timestamp('shared_at', { withTimezone: true }),
  copyCount: integer('copy_count').notNull().default(0),
  /** F17 FR-16: this board is a copy made from a shared link (survives the original being deleted). */
  copiedFromLinkAt: timestamp('copied_from_link_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('boards_user_idx').on(t.userId),
  // F19 admin: search by title (ILIKE) and newest first.
  index('boards_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
  index('boards_created_idx').on(t.createdAt.desc()),
  check('boards_share_token_chk', sql`(${t.access} = 'owner') = (${t.shareToken} is null)`),
  check('boards_share_password_chk', sql`(${t.access} = 'password') = (${t.sharePasswordHash} is not null)`),
  // only student boards are shared; seeds are readable by everyone, so a token there would leak
  check('boards_share_private_chk', sql`${t.access} = 'owner' or ${t.status} = 'private'`),
  check('boards_share_counters_chk', sql`${t.shareSecretVersion} >= 1 and ${t.copyCount} >= 0`),
]);

/** F17 FR-14: wrong-password log for the unlock limit. Server-only (RLS on, no policy); hashes, never the token or IP. */
export const shareAttempts = pgTable('share_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull(),
  ipHash: text('ip_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [index('share_attempts_lookup_idx').on(t.tokenHash, t.ipHash, t.createdAt)]);

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
  backAssetId: uuid('back_asset_id').references(() => assets.id, { onDelete: 'set null' }), // D-201
  width: integer('width'), // D-202: both null (default size) or both set; limits are a CHECK in the migration
  height: integer('height'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`), // D-204
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
}, (t) => [
  index('cards_board_idx').on(t.boardId),
  index('cards_back_asset_idx').on(t.backAssetId).where(sql`${t.backAssetId} is not null`),
  // limits mirror CARD_SIZE_MIN/MAX in @remoa/contracts
  check('cards_size_chk', sql`(${t.width} is null and ${t.height} is null) or (${t.width} between 140 and 640 and ${t.height} between 90 and 560)`),
  check('cards_tags_chk', sql`cardinality(${t.tags}) <= 50`),
]);

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


