import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  areaEnum, authUsers, boardAccessEnum, boardStatusEnum, cardShapeEnum, cardStatusEnum, cardTypeEnum, licenseEnum, roleEnum, timestamps, userId,
} from './common';
import { MAX_GOALS, boardBadges, sexes, userTypes, type BoardPath, type CardSource, type Didactics } from '@remoa/contracts';

export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  name: text('name'),
  role: roleEnum('role').notNull().default('student'),
  /** G20 (D-843): institution as shown (list name or free text). Server-owned since 0031 (PATCH /v1/account/profile `institution`). */
  school: text('school'),
  /** G20: MEDICAL_SCHOOLS id (@remoa/contracts); null = free text or not given. Server-owned (no column GRANT). No FK: static list. */
  schoolId: text('school_id'),
  year: integer('year'),
  goal: text('goal'),
  /** CCR-017 (D-570): every objective picked (goalSchema values); `goal` mirrors goals[0]. Server-owned (no column GRANT). */
  goals: text('goals').array().notNull().default(sql`'{}'::text[]`),
  // CCR-017 (D-571) personal data, PII: owner-only read (profiles_select), written only by the API (no column GRANT).
  userType: text('user_type'),
  sex: text('sex'),
  /** E.164, +55 only. */
  phone: text('phone'),
  /** AddressSchema (cep, street, number, complement, district, city, uf). */
  address: jsonb('address'),
  /** F10: council registration stamped on approved rubrics. */
  crm: text('crm'),
  /** F13: segments value (stageSchema), incl. G20 `not_med`. */
  stage: text('stage'),
  /** F13: processed 512 px WebP key; server-owned (no GRANT to authenticated). */
  avatarKey: text('avatar_key'),
  avatarColor: smallint('avatar_color').notNull().default(0),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  onboardingDoneAt: timestamp('onboarding_done_at', { withTimezone: true }),
  /** F12 (D-492): partial OnboardingAnswers as saved by POST /v1/onboarding/answers. Server-owned (no column GRANT). */
  onboardingAnswers: jsonb('onboarding_answers').notNull().default({}),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** F18: who referred this user (first touch, D-383). Server-owned (no column GRANT). */
  referredBy: uuid('referred_by').references(() => authUsers.id, { onDelete: 'set null' }),
  /** F19: set by the admin (withAdmin 'user.suspend'); blocks every /v1/* call. Server-owned (no column GRANT). */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedReason: text('suspended_reason'),
  /** G19 FR-45 (D-913): versions accepted at sign-up (handle_new_user) or later (POST /v1/account/legal/accept). Server-owned. */
  termsAcceptedVersion: text('terms_accepted_version'),
  privacyAcceptedVersion: text('privacy_accepted_version'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  check('profiles_avatar_color', sql`${t.avatarColor} between 0 and 4`),
  check('profiles_suspended', sql`(${t.suspendedAt} is null) = (${t.suspendedReason} is null)`),
  check('profiles_user_type', sql.raw(`user_type in (${userTypes.map((v) => `'${v}'`).join(', ')})`)),
  check('profiles_sex', sql.raw(`sex in (${sexes.map((v) => `'${v}'`).join(', ')})`)),
  check('profiles_phone', sql`${t.phone} ~ '^[+]55[1-9]{2}(9[0-9]{8}|[2-5][0-9]{7})$'`),
  check('profiles_address', sql`jsonb_typeof(${t.address}) = 'object'`),
  check('profiles_goals', sql`cardinality(${t.goals}) <= ${sql.raw(String(MAX_GOALS))}`),
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
  /** F31 (CCR-080, D-1460): trail of a ready map (BoardPathSchema), kept on copies; null = ordinary map. Server-owned (no UPDATE grant). */
  path: jsonb('path').$type<BoardPath>(),
  /** F31 (D-1461): library seals (boardBadges). Server-owned; only on seed boards (check). */
  badges: text('badges').array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
}, (t) => [
  index('boards_user_idx').on(t.userId),
  // F19 admin: search by title (ILIKE) and newest first.
  index('boards_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
  index('boards_created_idx').on(t.createdAt.desc()),
  // G21 FR-26 (0033): listBoards (apps/api/src/boards/boards.ts:61-62) and seed legs of boards_select / listSeeds (editorial.ts:295).
  index('boards_user_updated_idx').on(t.userId, t.updatedAt.desc()).where(sql`${t.archivedAt} is null`),
  index('boards_status_idx').on(t.status).where(sql`${t.status} <> 'private'`),
  check('boards_share_token_chk', sql`(${t.access} = 'owner') = (${t.shareToken} is null)`),
  check('boards_share_password_chk', sql`(${t.access} = 'password') = (${t.sharePasswordHash} is not null)`),
  // only student boards are shared; seeds are readable by everyone, so a token there would leak
  check('boards_share_private_chk', sql`${t.access} = 'owner' or ${t.status} = 'private'`),
  check('boards_share_counters_chk', sql`${t.shareSecretVersion} >= 1 and ${t.copyCount} >= 0`),
  check('boards_path_chk', sql`${t.path} is null or jsonb_typeof(${t.path}) = 'object'`),
  check('boards_badges_chk', sql.raw(`badges <@ array[${boardBadges.map((v) => `'${v}'`).join(', ')}]::text[] and (cardinality(badges) = 0 or status <> 'private')`)),
  // F31: build idempotency and /mapas-prontos/[slug]; copies (private) keep the path and may repeat the slug.
  uniqueIndex('boards_path_slug_idx').on(sql`(${t.path}->>'slug')`).where(sql`${t.path} is not null and ${t.status} <> 'private'`),
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
}, (t) => [index('assets_user_idx').on(t.userId)]); // G21 FR-26 (0033): assets_own policy, cleanup

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
  /** G22 (CCR-072): verbatim input passage behind an AI-generated card. */
  sourceExcerpt: text('source_excerpt'),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  status: cardStatusEnum('status').notNull().default('draft'),
  order: integer('order').notNull().default(0),
  reviewerId: uuid('reviewer_id').references(() => authUsers.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // F01: soft delete, 30 days
  /** F03 FR-9 (D-491): suspended by the owner; out of the review queue and challenges until unsuspended. FSRS state is kept. */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  /** F02 FR-9 (D-531): in a seed copy, the seed card this one was copied from. Null for own cards and pre-0023 copies. */
  sourceCardId: uuid('source_card_id').references((): AnyPgColumn => cards.id, { onDelete: 'set null' }),
  /** F31 (CCR-080, D-1457): DidacticsSchema; null = not a trail card. */
  didactics: jsonb('didactics').$type<Didactics>(),
  /** F31 (D-1452): CardSourceSchema[]. */
  sources: jsonb('sources').$type<CardSource[]>().notNull().default([]),
  /** F31 (D-1459): order of new cards in trail mode; null = outside the trail. */
  pathOrder: integer('path_order'),
  ...timestamps,
}, (t) => [
  index('cards_board_idx').on(t.boardId),
  index('cards_board_order_idx').on(t.boardId, t.order, t.createdAt).where(sql`${t.deletedAt} is null`), // G21 FR-26 (0033): getBoard boards.ts:82-83
  index('cards_source_card_idx').on(t.sourceCardId).where(sql`${t.sourceCardId} is not null`),
  index('cards_back_asset_idx').on(t.backAssetId).where(sql`${t.backAssetId} is not null`),
  // limits mirror CARD_SIZE_MIN/MAX in @remoa/contracts
  check('cards_size_chk', sql`(${t.width} is null and ${t.height} is null) or (${t.width} between 140 and 640 and ${t.height} between 90 and 560)`),
  check('cards_tags_chk', sql`cardinality(${t.tags}) <= 50`),
  check('cards_didactics_chk', sql`${t.didactics} is null or jsonb_typeof(${t.didactics}) = 'object'`),
  check('cards_sources_chk', sql`jsonb_typeof(${t.sources}) = 'array'`),
  index('cards_board_path_order_idx').on(t.boardId, t.pathOrder).where(sql`${t.pathOrder} is not null and ${t.deletedAt} is null`),
]);

/** F31 (CCR-080, D-1453): trail prerequisites, both cards in the same board (RLS WITH CHECK). */
export const cardPrereqs = pgTable('card_prereqs', {
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  prereqCardId: uuid('prereq_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  primaryKey({ columns: [t.cardId, t.prereqCardId] }),
  index('card_prereqs_prereq_idx').on(t.prereqCardId),
  check('card_prereqs_self_chk', sql`${t.cardId} <> ${t.prereqCardId}`),
]);

export const edges = pgTable('edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  fromCardId: uuid('from_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  toCardId: uuid('to_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  label: text('label'),
  question: text('question'),
  ...timestamps,
}, (t) => [
  index('edges_board_idx').on(t.boardId),
  // G21 FR-26 (0033): FK cascade from cards
  index('edges_from_card_idx').on(t.fromCardId),
  index('edges_to_card_idx').on(t.toCardId),
]);

export const masks = pgTable('masks', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }), // account deletion (F08) removes assets
  polygon: jsonb('polygon').notNull(),
  label: text('label'),
  ...timestamps,
}, (t) => [index('masks_card_idx').on(t.cardId)]); // G21 FR-26 (0033): cards.ts:90, masks_* policies, FK cascade

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
}, (t) => [index('board_versions_board_version_idx').on(t.boardId, t.version.desc())]); // G21 FR-26 (0033): getBoard boards.ts:90-95


