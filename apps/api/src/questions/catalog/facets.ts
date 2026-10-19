/** F34 FR-3/FR-8: disjunctive facet counts. Eligible rows only (readable()+latest via catalogWhere), distinct canonical, no answer key anywhere. */
import {effectiveArea,effectiveTopic,classificationNodes} from '../classification/semantics';
import { sql, type SQL } from 'drizzle-orm';
import { questionFacetGroups, questionFacetsSchema, type QuestionFacetQuery, type QuestionListQuery } from '@remoa/contracts';
import { asServer, pgArray, run } from '../../db';
import { catalogWhere, many, paperBase, paperFilters, stateJoin, type FilterGroup } from './service';

const toListQuery = (q: QuestionFacetQuery): QuestionListQuery => { const filters = { ...q }; delete filters.groups; delete filters.topicQuery; return { ...filters, limit: 25 } as QuestionListQuery; };
/** The five facet groups' own filters removed: what is left (access, latest, scope, source, search, state, examId) is the shared base. */
const withoutGroups = (q: QuestionListQuery): QuestionListQuery => ({ ...q, areaId: undefined, areaIds: undefined, topicId: undefined, topicIds: undefined, difficulty: undefined, difficulties: undefined, institution: undefined, institutions: undefined, year: undefined, years: undefined });

/**
 * G27 perf: the eligible base (readable + latest + every non-group filter) is computed ONCE (materialized: ids, canonical, area, topic,
 * difficulty) with its published paper rows (institution, year; examId already applied); each group then filters the other four groups
 * over that base. Same semantics as one catalogWhere(omit) per group: institution and year must hold on the same paper row.
 */
export function questionFacetSQL(userId: string, query: QuestionFacetQuery): SQL {
  const list = toListQuery(query), groups = new Set(query.groups ?? questionFacetGroups);
  const areas = many(list.areaIds, list.areaId), topics = many(list.topicIds, list.topicId), diffs = many(list.difficulties, list.difficulty);
  const years = many(list.years, list.year).map(String), insts = many(list.institutions, list.institution);
  const instCond = sql`pp.inst_key=ANY(ARRAY(SELECT lower(btrim(x)) FROM unnest(${pgArray(insts, 'text')}) x))`, yearCond = sql`pp.year::text=ANY(${pgArray(years, 'text')})`;
  /** Every group filter except `omit`, on base row `b`. `paperRow`: the caller already joins a paper row `pp` (institution/year groups). */
  const cond = (omit?: FilterGroup, paperRow = false): SQL => {
    const parts: SQL[] = [sql`true`];
    if (omit !== 'area' && areas.length) parts.push(sql`b.area=ANY(${pgArray(areas, 'uuid')})`);
    if (omit !== 'topic' && topics.length) parts.push(sql`b.topic=ANY(${pgArray(topics, 'uuid')})`);
    if (omit !== 'difficulty' && diffs.length) parts.push(sql`b.difficulty=ANY(${pgArray(diffs, 'text')})`);
    const pf: SQL[] = [];
    if (omit !== 'institution' && insts.length) pf.push(instCond);
    if (omit !== 'year' && years.length) pf.push(yearCond);
    if (paperRow) parts.push(...pf);
    else if (pf.length) parts.push(sql`EXISTS(SELECT 1 FROM papers pp WHERE pp.id=b.id AND ${sql.join(pf, sql` AND `)})`);
    return sql.join(parts, sql` AND `);
  };
  const agg = (inner: SQL) => sql`(SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) FROM (${inner}) g)`;
  const parts: SQL[] = [sql`'total',(SELECT count(DISTINCT b.canonical)::int FROM base b WHERE ${cond()})`];
  if (groups.has('area')) parts.push(sql`'areas',${agg(sql`SELECT b.area id,count(DISTINCT b.canonical)::int count FROM base b WHERE ${cond('area')} AND b.area IS NOT NULL GROUP BY 1 ORDER BY count DESC,id LIMIT 50`)}`);
  if (groups.has('topic')) {
    const text = query.topicQuery ? sql`AND tp.label ILIKE ${'%' + query.topicQuery.replace(/[\\%_]/g, '\\$&') + '%'}` : sql``;
    parts.push(sql`'topics',${agg(sql`SELECT tp.id,tp.label name,count(DISTINCT b.canonical)::int count FROM base b JOIN ${classificationNodes} tp ON tp.id=b.topic WHERE ${cond('topic')} ${text} GROUP BY tp.id,tp.label ORDER BY count DESC,tp.label,tp.id LIMIT 50`)}`);
  }
  if (groups.has('institution')) parts.push(sql`'institutions',${agg(sql`SELECT min(pp.inst) name,count(DISTINCT b.canonical)::int count FROM base b JOIN papers pp ON pp.id=b.id WHERE ${cond('institution', true)} AND pp.inst<>'' GROUP BY pp.inst_key ORDER BY count DESC,pp.inst_key LIMIT 100`)}`);
  if (groups.has('year')) parts.push(sql`'years',${agg(sql`SELECT pp.year,count(DISTINCT b.canonical)::int count FROM base b JOIN papers pp ON pp.id=b.id WHERE ${cond('year', true)} GROUP BY pp.year ORDER BY pp.year DESC LIMIT 100`)}`);
  if (groups.has('difficulty')) parts.push(sql`'difficulties',${agg(sql`SELECT b.difficulty value,count(DISTINCT b.canonical)::int count FROM base b WHERE ${cond('difficulty')} GROUP BY 1 ORDER BY CASE b.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`)}`);
  const base = withoutGroups(list);
  // `papers` is only scanned when a group or a filter references it (an unreferenced CTE is never executed).
  const statement = sql`WITH base AS MATERIALIZED (SELECT q.id,coalesce(q.canonical_id,q.id) canonical,${effectiveArea} area,${effectiveTopic} topic,q.difficulty::text difficulty
      FROM question_bank q ${stateJoin(userId, list)} WHERE ${catalogWhere(userId, base)}),
    papers AS MATERIALIZED (SELECT o.question_id id,btrim(p.institution) inst,lower(btrim(p.institution)) inst_key,p.year FROM base JOIN exam_question_occurrences o ON o.question_id=base.id
      JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources ps ON ps.id=p.source_id WHERE ${sql.join([paperBase, ...paperFilters(base)], sql` AND `)})
    SELECT jsonb_build_object(${sql.join(parts, sql`,`)}) facets`;
  return statement;
}
export async function questionFacets(userId: string, query: QuestionFacetQuery) {
  return run(userId, async (tx) => {
    const [row] = await asServer<{ facets: unknown }>(tx, questionFacetSQL(userId,query));
    return questionFacetsSchema.parse(row!.facets);
  });
}
