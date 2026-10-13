/** F34 FR-3/FR-8: disjunctive facet counts. Eligible rows only (readable()+latest via catalogWhere), distinct canonical, no answer key anywhere. */
import { sql, type SQL } from 'drizzle-orm';
import { questionFacetGroups, questionFacetsSchema, type QuestionFacetQuery, type QuestionListQuery } from '@remoa/contracts';
import { asServer, run } from '../../db';
import { catalogWhere, paperBase, paperFilters, stateJoin, type FilterGroup } from './service';

const canonical = sql`coalesce(q.canonical_id,q.id)`;
const toListQuery = (q: QuestionFacetQuery): QuestionListQuery => { const filters = { ...q }; delete filters.groups; delete filters.topicQuery; return { ...filters, limit: 25 } as QuestionListQuery; };

export async function questionFacets(userId: string, query: QuestionFacetQuery) {
  const list = toListQuery(query), groups = new Set(query.groups ?? questionFacetGroups), sj = stateJoin(userId, list);
  const where = (omit?: FilterGroup) => catalogWhere(userId, list, false, omit);
  // Occurrence join for institution/year groups: the other paper filters keep holding on the same paper row.
  const paperJoin = sql`JOIN exam_question_occurrences o ON o.question_id=q.id JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources ps ON ps.id=p.source_id`;
  const paperWhere = (omit: FilterGroup): SQL => sql.join([paperBase, ...paperFilters(list, omit)], sql` AND `);
  // One statement (one role switch, one round trip): every group is a jsonb_agg subselect.
  const agg = (inner: SQL) => sql`(SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) FROM (${inner}) g)`;
  const parts: SQL[] = [sql`'total',(SELECT count(DISTINCT ${canonical})::int FROM question_bank q ${sj} WHERE ${where()})`];
  if (groups.has('area')) parts.push(sql`'areas',${agg(sql`SELECT q.enamed_area_id id,count(DISTINCT ${canonical})::int count FROM question_bank q ${sj} WHERE ${where('area')} AND q.enamed_area_id IS NOT NULL GROUP BY 1 ORDER BY count DESC,id LIMIT 50`)}`);
  if (groups.has('topic')) {
    const text = query.topicQuery ? sql`AND tp.name ILIKE ${'%' + query.topicQuery.replace(/[\\%_]/g, '\\$&') + '%'}` : sql``;
    parts.push(sql`'topics',${agg(sql`SELECT tp.id,tp.name,count(DISTINCT ${canonical})::int count FROM question_bank q ${sj} JOIN enamed_taxonomy tp ON tp.id=q.enamed_topic_id WHERE ${where('topic')} ${text} GROUP BY tp.id,tp.name ORDER BY count DESC,tp.name,tp.id LIMIT 50`)}`);
  }
  if (groups.has('institution')) parts.push(sql`'institutions',${agg(sql`SELECT min(btrim(p.institution)) name,count(DISTINCT ${canonical})::int count FROM question_bank q ${sj} ${paperJoin} WHERE ${where('institution')} AND ${paperWhere('institution')} AND btrim(p.institution)<>'' GROUP BY lower(btrim(p.institution)) ORDER BY count DESC,lower(btrim(p.institution)) LIMIT 100`)}`);
  if (groups.has('year')) parts.push(sql`'years',${agg(sql`SELECT p.year,count(DISTINCT ${canonical})::int count FROM question_bank q ${sj} ${paperJoin} WHERE ${where('year')} AND ${paperWhere('year')} GROUP BY p.year ORDER BY p.year DESC LIMIT 100`)}`);
  if (groups.has('difficulty')) parts.push(sql`'difficulties',${agg(sql`SELECT q.difficulty::text value,count(DISTINCT ${canonical})::int count FROM question_bank q ${sj} WHERE ${where('difficulty')} GROUP BY 1 ORDER BY CASE q.difficulty::text WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`)}`);
  return run(userId, async (tx) => {
    const [row] = await asServer<{ facets: unknown }>(tx, sql`SELECT jsonb_build_object(${sql.join(parts, sql`,`)}) facets`);
    return questionFacetsSchema.parse(row!.facets);
  });
}
