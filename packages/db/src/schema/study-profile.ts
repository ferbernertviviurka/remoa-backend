// G28-P / F35 (CCR-160): study profile + health-area reference data. RLS, audit trigger and backfill in 0057 (hand-written part).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import {
  MAX_GOALS, STUDY_PROFILE_LIMITS as L, brUfs, councilCodes, healthCourseCodes, healthCourseKinds, institutionTypes,
  referenceSuggestionKinds, studyGoalCodes, studyProfileSources, studySituations,
} from '@remoa/contracts';
import { authUsers, timestamps } from './common';

const q = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const inS = (col: string, values: readonly string[]) => `${col} in (${q(values)})`;
const inList = (col: string, values: readonly string[]) => sql.raw(inS(col, values));
const optIn = (col: string, values: readonly string[]) => sql.raw(`${col} is null or ${inS(col, values)}`);
const subS = (col: string, values: readonly string[]) => `${col} <@ array[${q(values)}]::text[]`;
const len = (col: string, max: number) => `(${col} is null or char_length(${col}) between 1 and ${max})`;

export const councils = pgTable('councils', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
}, () => [check('councils_code', inList('code', councilCodes))]);

export const healthCourses = pgTable('health_courses', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** Search synonyms as typed (normalized with normalizeSearch on match). */
  aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  kind: text('kind').notNull(),
  councilCode: text('council_code').references(() => councils.code),
  suggestedGoals: text('suggested_goals').array().notNull().default(sql`'{}'::text[]`),
  sort: smallint('sort').notNull().default(0),
}, () => [
  check('health_courses_code', inList('code', healthCourseCodes)),
  check('health_courses_kind', inList('kind', healthCourseKinds)),
  check('health_courses_goals', sql.raw(subS('suggested_goals', studyGoalCodes))),
]);

export const studyGoals = pgTable('study_goals', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** null = any course. */
  courseCodes: text('course_codes').array(),
  sort: smallint('sort').notNull().default(0),
}, () => [
  check('study_goals_code', inList('code', studyGoalCodes)),
  check('study_goals_courses', sql.raw(`course_codes is null or ${subS('course_codes', healthCourseCodes)}`)),
]);

/** e-MEC open data (Q-114). `search` = normalizeSearch(name acronym city), written by the seed loader. */
export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  emecCode: integer('emec_code').notNull().unique(),
  name: text('name').notNull(),
  acronym: text('acronym'),
  city: text('city').notNull(),
  uf: text('uf').notNull(),
  type: text('type').notNull(),
  search: text('search').notNull(),
  ...timestamps,
}, (t) => [
  check('institutions_uf', inList('uf', brUfs)),
  check('institutions_type', inList('type', institutionTypes)),
  index('institutions_search_trgm_idx').using('gin', t.search.op('gin_trgm_ops')),
]);

/** One per user (FR-1). Owner-only RLS; council_number is private (never shown to anyone but the owner). */
export const studyProfiles = pgTable('study_profiles', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  /** null only while source = 'migration'. */
  situation: text('situation'),
  /** health_courses.code; no FK (closed list in @remoa/contracts, checked below), like profiles.school_id. */
  courseCode: text('course_code'),
  courseOtherText: text('course_other_text'),
  institutionId: uuid('institution_id').references(() => institutions.id, { onDelete: 'set null' }),
  institutionText: text('institution_text'),
  city: text('city'),
  uf: text('uf'),
  institutionType: text('institution_type'),
  period: smallint('period'),
  goals: text('goals').array().notNull().default(sql`'{}'::text[]`),
  customGoals: text('custom_goals').array().notNull().default(sql`'{}'::text[]`),
  councilNumber: text('council_number'),
  nonHealthTopic: text('non_health_topic'),
  source: text('source').notNull(),
  ...timestamps,
}, () => [
  check('study_profiles_source', inList('source', studyProfileSources)),
  check('study_profiles_situation', optIn('situation', studySituations)),
  check('study_profiles_course', optIn('course_code', healthCourseCodes)),
  check('study_profiles_uf', optIn('uf', brUfs)),
  check('study_profiles_institution_type', optIn('institution_type', institutionTypes)),
  check('study_profiles_goals', sql.raw(`${subS('goals', studyGoalCodes)} and cardinality(goals) <= ${MAX_GOALS}`)),
  check('study_profiles_custom_goals', sql.raw(`cardinality(custom_goals) <= ${L.customGoals}`)),
  // Confirmed rows are complete (FR-9): course, situation, at least one goal.
  check('study_profiles_complete', sql`source = 'migration' or (course_code is not null and situation is not null and cardinality(goals) + cardinality(custom_goals) >= 1)`),
  check('study_profiles_period', sql`period is null or (period between 1 and 12 and situation = 'graduacao' and course_code <> 'not_health')`),
  check('study_profiles_council', sql.raw(`council_number is null or (situation = 'profissional' and char_length(council_number) between 1 and ${L.councilNumber})`)),
  check('study_profiles_other', sql`(coalesce(course_code, '') = 'other_health') = (course_other_text is not null)`),
  check('study_profiles_non_health', sql`(coalesce(course_code, '') = 'not_health') = (non_health_topic is not null)`),
  check('study_profiles_institution', sql`institution_id is null or institution_text is null`),
  check('study_profiles_lengths', sql.raw([
    len('course_other_text', L.courseOther), len('institution_text', L.institutionText), len('city', L.city), len('non_health_topic', L.nonHealthTopic),
  ].join(' and '))),
]);

/** FR-25 light audit: who, when, which fields (names only, never values). Written by a trigger; server-only. */
export const studyProfileAudit = pgTable('study_profile_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  /** auth.uid() of the writer; null = server/migration. */
  actorId: uuid('actor_id'),
  fields: text('fields').array().notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [index('study_profile_audit_user_at_idx').on(t.userId, t.at)]);

/** FR-6 curation queue for "Usar o que digitei". No user id on purpose (moderation without exposing the author). Server-only. */
export const referenceSuggestions = pgTable('reference_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  normalized: text('normalized').notNull(),
  count: integer('count').notNull().default(1),
  status: text('status').notNull().default('pending'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().default(sql`now()`),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  unique('reference_suggestions_kind_normalized_uq').on(t.kind, t.normalized),
  check('reference_suggestions_kind', inList('kind', referenceSuggestionKinds)),
  check('reference_suggestions_status', sql`status in ('pending', 'accepted', 'rejected')`),
  check('reference_suggestions_text', sql`char_length(text) between 2 and 160`),
]);
