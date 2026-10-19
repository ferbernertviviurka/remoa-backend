/** F34: automatic, unreviewed suggestions live outside the signed question and never change editorial approval. */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { healthProfessionCodes, QUESTION_CLASSIFICATION_BUNDLE_HASH, QUESTION_CLASSIFICATION_EXPECTED_COUNT, QUESTION_CLASSIFICATION_NAMESPACE, QUESTION_CLASSIFICATION_NODE_COUNT, QUESTION_CLASSIFICATION_QUEUE_HASH, QUESTION_CLASSIFICATION_RULE_HASH, QUESTION_CLASSIFICATION_RUN_ID, QUESTION_TEAM_CORPUS_HASH, QUESTION_TEAM_MEMBERSHIP_HASH } from '@remoa/contracts';
import { authUsers } from './common';
import { questionBank } from './challenge-ai';
const quoted = (value: string) => sql.raw(`'${value.replaceAll("'", "''")}'`);
export const questionClassificationRuns = pgTable('question_classification_runs', {
  id: uuid('id').primaryKey(), namespace: text('namespace').notNull().unique(),
  queueHash: text('queue_hash').notNull(), ruleHash: text('rule_hash').notNull(), ruleVersion: text('rule_version').notNull(), bundleHash: text('bundle_hash').notNull(),
  corpusHash: text('corpus_hash').notNull(), membershipHash: text('membership_hash').notNull(),
  expectedCount: integer('expected_count').notNull(), expectedNodes: integer('expected_nodes').notNull(),
  classificationKind: text('classification_kind').notNull().default('automatic_unreviewed'),
  status: text('status', { enum: ['draft', 'active', 'withdrawn'] }).notNull().default('draft'),
  actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }), withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
}, t => [
  check('question_classification_run_pin_chk', sql`${t.id}=${quoted(QUESTION_CLASSIFICATION_RUN_ID)}::uuid AND ${t.namespace}=${quoted(QUESTION_CLASSIFICATION_NAMESPACE)} AND ${t.queueHash}=${quoted(QUESTION_CLASSIFICATION_QUEUE_HASH)} AND ${t.ruleHash}=${quoted(QUESTION_CLASSIFICATION_RULE_HASH)} AND ${t.ruleVersion}='remoa-team-classification-rules-1' AND ${t.bundleHash}=${quoted(QUESTION_CLASSIFICATION_BUNDLE_HASH)} AND ${t.corpusHash}=${quoted(QUESTION_TEAM_CORPUS_HASH)} AND ${t.membershipHash}=${quoted(QUESTION_TEAM_MEMBERSHIP_HASH)} AND ${t.expectedCount}=${sql.raw(String(QUESTION_CLASSIFICATION_EXPECTED_COUNT))} AND ${t.expectedNodes}=${sql.raw(String(QUESTION_CLASSIFICATION_NODE_COUNT))}`),
  check('question_classification_run_kind_chk', sql`${t.classificationKind}='automatic_unreviewed'`),
  check('question_classification_run_phase_chk', sql`(${t.status}='draft' AND ${t.activatedAt} IS NULL AND ${t.withdrawnAt} IS NULL) OR (${t.status}='active' AND ${t.activatedAt} IS NOT NULL AND ${t.withdrawnAt} IS NULL) OR (${t.status}='withdrawn' AND ${t.activatedAt} IS NOT NULL AND ${t.withdrawnAt} IS NOT NULL)`),
]).enableRLS();
export const questionClassificationNodes = pgTable('question_classification_nodes', {
  id: uuid('id').primaryKey(), runId: uuid('run_id').notNull().references(() => questionClassificationRuns.id),
  courseCode: text('course_code', { enum: healthProfessionCodes }).notNull(),
  kind: text('kind', { enum: ['area', 'topic'] }).notNull(), parentId: uuid('parent_id'), code: text('code').notNull(), label: text('label').notNull(),
}, t => [
  unique('question_classification_nodes_scope_uq').on(t.id, t.runId, t.courseCode),
  unique('question_classification_nodes_code_uq').on(t.runId, t.courseCode, t.kind, t.code),
  foreignKey({ name: 'question_classification_nodes_parent_fk', columns: [t.parentId, t.runId, t.courseCode], foreignColumns: [t.id, t.runId, t.courseCode] }),
  index('question_classification_nodes_course_idx').on(t.runId, t.courseCode, t.kind),
  check('question_classification_nodes_course_chk', sql`${t.courseCode} IN (${sql.raw(healthProfessionCodes.map(value => `'${value}'`).join(','))})`),
  check('question_classification_nodes_kind_chk', sql`${t.kind} IN ('area','topic') AND (${t.kind}='area')=(${t.parentId} IS NULL) AND ${t.id} IS DISTINCT FROM ${t.parentId}`),
  check('question_classification_nodes_labels_chk', sql`${t.code}~'^[a-z0-9.-]{1,180}$' AND length(btrim(${t.label})) BETWEEN 1 AND 300`),
]).enableRLS();
export const questionClassificationBindings = pgTable('question_classification_bindings', {
  runId: uuid('run_id').notNull().references(() => questionClassificationRuns.id),
  questionId: uuid('question_id').notNull().references(() => questionBank.id),
  contentHash: text('content_hash').notNull(), payloadHash: text('payload_hash').notNull(),
  courseCode: text('course_code', { enum: healthProfessionCodes }).notNull(), areaId: uuid('area_id').notNull(), topicId: uuid('topic_id').notNull(),
  evidence: jsonb('evidence').$type<{ ruleId: string; signals: { pattern: string; start: number; end: number; text: string }[] }>().notNull(),
}, t => [
  primaryKey({ columns: [t.runId, t.questionId] }), unique('question_classification_binding_question_uq').on(t.questionId),
  foreignKey({ name: 'question_classification_binding_area_fk', columns: [t.areaId, t.runId, t.courseCode], foreignColumns: [questionClassificationNodes.id, questionClassificationNodes.runId, questionClassificationNodes.courseCode] }),
  foreignKey({ name: 'question_classification_binding_topic_fk', columns: [t.topicId, t.runId, t.courseCode], foreignColumns: [questionClassificationNodes.id, questionClassificationNodes.runId, questionClassificationNodes.courseCode] }),
  index('question_classification_binding_filter_idx').on(t.runId, t.courseCode, t.areaId, t.topicId),
  check('question_classification_binding_hash_chk', sql`${t.contentHash}~'^[a-f0-9]{64}$' AND ${t.payloadHash}~'^[a-f0-9]{64}$'`),
  check('question_classification_binding_evidence_chk', sql`jsonb_typeof(${t.evidence})='object' AND jsonb_typeof(${t.evidence}->'signals')='array' AND jsonb_array_length(${t.evidence}->'signals') BETWEEN 2 AND 8 AND length(${t.evidence}->>'ruleId') BETWEEN 1 AND 100 AND octet_length(${t.evidence}::text)<=8192`),
]).enableRLS();
