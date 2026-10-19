/** G29-P: private, immutable membership and explicit human team declaration, not third-party permission. */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { healthProfessionCodes, QUESTION_TEAM_ATTESTATION, QUESTION_TEAM_CORPUS_HASH, QUESTION_TEAM_EXPECTED_COUNT, QUESTION_TEAM_MANIFEST_HASH, QUESTION_TEAM_MEMBERSHIP_HASH, QUESTION_TEAM_NAMESPACE } from '@remoa/contracts';
import { authUsers } from './common';
import { questionBank } from './challenge-ai';
import { questionSourcesCatalog } from './question-catalog';
export const questionTeamBatches = pgTable('question_team_batches', {
  id: uuid('id').primaryKey().defaultRandom(), namespace: text('namespace').notNull().unique(),
  corpusHash: text('corpus_hash').notNull(), manifestHash: text('manifest_hash').notNull(), membershipHash: text('membership_hash').notNull(), expectedCount: integer('expected_count').notNull(),
  attestation: text('attestation').notNull(), actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }),
  declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
  sealedAt: timestamp('sealed_at', { withTimezone: true }), activatedAt: timestamp('activated_at', { withTimezone: true }), revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  check('question_team_batch_pin_chk', sql`${t.namespace}=${sql.raw("'" + QUESTION_TEAM_NAMESPACE.replaceAll("'", "''") + "'")} AND ${t.corpusHash}=${sql.raw("'" + QUESTION_TEAM_CORPUS_HASH.replaceAll("'", "''") + "'")} AND ${t.manifestHash}=${sql.raw("'" + QUESTION_TEAM_MANIFEST_HASH.replaceAll("'", "''") + "'")} AND ${t.membershipHash}=${sql.raw("'" + QUESTION_TEAM_MEMBERSHIP_HASH.replaceAll("'", "''") + "'")} AND ${t.expectedCount}=${sql.raw(String(QUESTION_TEAM_EXPECTED_COUNT))} AND ${t.attestation}=${sql.raw("'" + QUESTION_TEAM_ATTESTATION.replaceAll("'", "''") + "'")}`),
  check('question_team_batch_phase_chk', sql`(${t.activatedAt} IS NULL OR ${t.sealedAt} IS NOT NULL) AND (${t.revokedAt} IS NULL OR ${t.activatedAt} IS NOT NULL)`),
]).enableRLS();
export const questionTeamItems = pgTable('question_team_items', {
  id: uuid('id').primaryKey().defaultRandom(), batchId: uuid('batch_id').notNull().references(() => questionTeamBatches.id), offlineId: text('offline_id').notNull(),
  questionId: uuid('question_id').notNull().references(() => questionBank.id), sourceId: uuid('source_id').notNull().references(() => questionSourcesCatalog.id),
  payloadHash: text('payload_hash').notNull(), sourceLineHash: text('source_line_hash').notNull(), contentHash: text('content_hash').notNull(), scopeHash: text('scope_hash').notNull(),
  professionCode: text('profession_code', { enum: healthProfessionCodes }).notNull(), flags: text('flags').array().notNull().default(sql`'{}'::text[]`), originalPayload: jsonb('original_payload').$type<Record<string, unknown>>().notNull(),
}, t => [
  unique('question_team_items_batch_offline_uq').on(t.batchId, t.offlineId), unique('question_team_items_question_uq').on(t.questionId),
  index('question_team_items_source_idx').on(t.sourceId),
  check('question_team_items_hash_chk', sql`${t.payloadHash}~'^[a-f0-9]{64}$' AND ${t.sourceLineHash}~'^[a-f0-9]{64}$' AND ${t.contentHash}~'^[a-f0-9]{64}$' AND ${t.scopeHash}~'^[a-f0-9]{64}$'`),
  check('question_team_items_flags_chk', sql`${t.flags}<@ARRAY['annulled','key_conflict','image_missing','key_finality_unverified']::text[] AND cardinality(${t.flags})<=4`),
  check('question_team_items_payload_chk', sql`jsonb_typeof(${t.originalPayload})='object' AND octet_length(${t.originalPayload}::text)<=1048576 AND length(${t.offlineId}) BETWEEN 1 AND 300`),
  check('question_team_items_profession_chk', sql`${t.professionCode} IN (${sql.raw(healthProfessionCodes.map(v => "'" + v + "'").join(','))})`),
]).enableRLS();
