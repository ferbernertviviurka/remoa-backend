/**
 * G28 / CCR150 / D1845, proposed0057. NOT wired into schema/index or generated/applied yet.
 * Column factories allow the owning lane to extend existing tables atomically; no second question/version table.
 * RLS, evidence/immutability/publication triggers live in docs/.../schema-proposal.sql for review only.
 */
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { healthLanguageTags, healthProfessionCodes, type QuestionCurationScope, type QuestionCurationSourceRevision } from '@remoa/contracts';
import { authUsers, timestamps } from './common';
import { questionSourcesCatalog, questionEditorialReviews } from './question-catalog';

const oneOf = (column: AnyPgColumn, values: readonly string[]) => sql`${column} IN (${sql.raw(values.map(v => `'${v}'`).join(','))})`;
export const healthTaxonomy = pgTable('health_taxonomy', {
  id: uuid('id').primaryKey().defaultRandom(), professionCode: text('profession_code', { enum: healthProfessionCodes }).notNull(),
  kind: text('kind', { enum: ['area', 'topic', 'general'] }).notNull(), parentId: uuid('parent_id'),
  code: text('code').notNull(), label: text('label').notNull(), revision: integer('revision').notNull(),
  status: text('status', { enum: ['draft', 'reviewed', 'withdrawn'] }).notNull().default('draft'), ...timestamps,
}, t => [
  unique('health_taxonomy_id_profession_uq').on(t.id, t.professionCode),
  unique('health_taxonomy_code_revision_uq').on(t.professionCode, t.code, t.revision),
  foreignKey({ name: 'health_taxonomy_parent_profession_fk', columns: [t.parentId, t.professionCode], foreignColumns: [t.id, t.professionCode] }),
  index('health_taxonomy_parent_idx').on(t.parentId),
  index('health_taxonomy_profession_status_idx').on(t.professionCode, t.status),
  check('health_taxonomy_profession_chk', oneOf(t.professionCode, healthProfessionCodes)),
  check('health_taxonomy_kind_chk', sql`${t.kind} IN ('area','topic','general')`),
  check('health_taxonomy_status_chk', sql`${t.status} IN ('draft','reviewed','withdrawn')`),
  check('health_taxonomy_revision_chk', sql`${t.revision} > 0`),
  check('health_taxonomy_parent_chk', sql`(${t.kind} = 'area') = (${t.parentId} IS NULL) AND ${t.parentId} IS DISTINCT FROM ${t.id}`),
  check('health_taxonomy_labels_chk', sql`${t.code} ~ '^[a-zA-Z0-9_.-]{1,100}$' AND length(btrim(${t.label})) BETWEEN 1 AND 300`),
]);

export const questionSourceRevisions = pgTable('question_source_revisions', {
  id: uuid('id').primaryKey().defaultRandom(), sourceId: uuid('source_id').notNull().references(() => questionSourcesCatalog.id),
  revision: integer('revision').notNull(), revisionLabel: text('revision_label').notNull(), manifestSha256: text('manifest_sha256').notNull(),
  documents: jsonb('documents').$type<QuestionCurationSourceRevision['documents']>().notNull(),
  license: jsonb('license').$type<QuestionCurationSourceRevision['license']>().notNull(),
  attribution: jsonb('attribution').$type<QuestionCurationSourceRevision['attribution']>().notNull(),
  status: text('status', { enum: ['draft', 'verified', 'withdrawn'] }).notNull().default('draft'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }), ...timestamps,
}, t => [
  unique('question_source_revisions_source_revision_uq').on(t.sourceId, t.revision),
  index('question_source_revisions_actor_idx').on(t.actorId),
  check('question_source_revisions_revision_chk', sql`${t.revision} > 0`),
  check('question_source_revisions_label_chk', sql`length(btrim(${t.revisionLabel})) BETWEEN 1 AND 200`),
  check('question_source_revisions_hash_chk', sql`${t.manifestSha256} ~ '^[a-f0-9]{64}$'`),
  check('question_source_revisions_status_chk', sql`${t.status} IN ('draft','verified','withdrawn')`),
  check('question_source_revisions_json_chk', sql`jsonb_typeof(${t.documents}) = 'array' AND jsonb_typeof(${t.license}) = 'object' AND jsonb_typeof(${t.attribution}) = 'object' AND octet_length(${t.documents}::text) <= 65536 AND octet_length(${t.license}::text) <= 8192 AND octet_length(${t.attribution}::text) <= 16384`),
  check('question_source_revisions_verified_chk', sql`${t.status} <> 'verified' OR (${t.verifiedAt} IS NOT NULL AND ${t.license}->>'scope' = 'licensed_external' AND ${t.license}->>'verified' = 'true') IS TRUE`),
]);

/** Nullable without defaults: legacy records are not silently classified as Portuguese/a profession. */
export const healthCurationQuestionColumns = () => ({
  professionCode: text('profession_code', { enum: healthProfessionCodes }), professionTags: text('profession_tags').array(),
  professionVerified: boolean('profession_verified'), languageTag: text('language_tag', { enum: healthLanguageTags }), languageVerified: boolean('language_verified'),
  healthAreaId: uuid('health_area_id').references(() => healthTaxonomy.id), healthTopicId: uuid('health_topic_id').references(() => healthTaxonomy.id),
  healthTaxonomyVerified: boolean('health_taxonomy_verified'),
  sourceRevisionId: uuid('source_revision_id').references(() => questionSourceRevisions.id),
  explanationStatus: text('explanation_status', { enum: ['absent', 'source_provided', 'remoa_curated', 'medical_reviewed'] }),
  explanationReviewId: uuid('explanation_review_id').references(() => questionEditorialReviews.id),
  /** Precise private readiness metadata; not consent and never client-writable through approval. */
  curationPersonalDataStatus: text('curation_personal_data_status', { enum: ['unassessed', 'not_detected', 'detected'] }),
  curationScope: jsonb('curation_scope').$type<QuestionCurationScope>(),
  curationScopeHash: text('curation_scope_hash'), curationReviewedScopeHash: text('curation_reviewed_scope_hash'),
});
export const healthCurationReviewColumns = () => ({
  curationScopeHash: text('curation_scope_hash'), curationScopeSnapshot: jsonb('curation_scope_snapshot').$type<QuestionCurationScope>(),
  sourceRevisionId: uuid('source_revision_id').references(() => questionSourceRevisions.id),
  curationPersonalDataStatus: text('curation_personal_data_status', { enum: ['unassessed', 'not_detected', 'detected'] }),
});
