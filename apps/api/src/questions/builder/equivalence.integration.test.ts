/**
 * G27 perf refactor guard: the single-scan facets / availability / preview must give exactly the output of the previous multi-scan
 * statements (frozen verbatim below as `legacy*`) on the same fixtures and seeds. Synthetic data, isolated f33_test database only.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  allocateExam, examAvailabilitySchema, examBuilderFilterSchema, examBuilderParamsSchema, examPreviewSchema, questionFacetGroups, questionFacetQuerySchema, questionFacetsSchema,
  type AllocationArea, type ExamBuilderFilter, type ExamBuilderParams, type QuestionFacetQuery, type QuestionListQuery,
} from '@remoa/contracts';
import type { db as database } from '@remoa/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertF33TestDb } from '../test-db-guard';
import { asServer, pgArray, run } from '../../db';
import { catalogWhere, paperBase, paperFilters, stateJoin, validationOf, type FilterGroup, type Row } from '../catalog/service';
import { questionFacets } from '../catalog/facets';
import { examBuilder, eligibleWhere, stemPreview } from './service';
vi.mock('../../cache', () => ({ invalidate: vi.fn(async () => {}) }));
const url = process.env.DATABASE_URL;
assertF33TestDb(url);

// ---- legacy (pre-G27-perf) implementations, verbatim apart from names --------------------------------------------------------
const canonical = sql`coalesce(q.canonical_id,q.id)`;
const toListQuery = (q: QuestionFacetQuery): QuestionListQuery => { const filters = { ...q }; delete filters.groups; delete filters.topicQuery; return { ...filters, limit: 25 } as QuestionListQuery; };
async function legacyFacets(userId: string, query: QuestionFacetQuery) {
  const list = toListQuery(query), groups = new Set(query.groups ?? questionFacetGroups), sj = stateJoin(userId, list);
  const where = (omit?: FilterGroup) => catalogWhere(userId, list, false, omit);
  const paperJoin = sql`JOIN exam_question_occurrences o ON o.question_id=q.id JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources ps ON ps.id=p.source_id`;
  const paperWhere = (omit: FilterGroup): SQL => sql.join([paperBase, ...paperFilters(list, omit)], sql` AND `);
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
const ids = (xs: readonly string[]) => pgArray(xs, 'uuid');
const canon = sql`coalesce(q.canonical_id,q.id)`;
function filterWhere(userId: string, f: ExamBuilderFilter): SQL {
  const parts = [eligibleWhere(userId, f.source, f.progress)];
  if (f.areaIds.length) parts.push(sql`q.enamed_area_id=ANY(${ids(f.areaIds)})`);
  if (f.topicIds.length || f.matrixItemIds.length) parts.push(sql`q.enamed_topic_id IN (WITH RECURSIVE t AS (
    SELECT id FROM enamed_taxonomy WHERE id=ANY(${ids(f.topicIds)}) OR matrix_ref=ANY(${ids(f.matrixItemIds)})
    UNION SELECT c.id FROM enamed_taxonomy c JOIN t ON c.parent_id=t.id) SELECT id FROM t)`);
  if (f.difficulties.length) parts.push(sql`q.difficulty::text=ANY(${pgArray(f.difficulties, 'text')})`);
  return sql.join(parts, sql` AND `);
}
const notIn = (xs: readonly string[]) => xs.length
  ? sql`q.id<>ALL(${ids(xs)}) AND ${canon} NOT IN (SELECT coalesce(x.canonical_id,x.id) FROM question_bank x WHERE x.id=ANY(${ids(xs)}))` : sql`true`;
const itemColumns = sql`q.id,${canon} canonical_id,q.version,q.enamed_area_id,q.enamed_topic_id,q.origin,q.difficulty,q.stem,q.visibility,q.validation_kind,
  q.reviewer_name validation_label,(q.reviewed_hash IS NOT NULL AND q.reviewed_hash=q.content_hash) reviewed,src.name source_label`;
const toItem = (r: Row, pinned: boolean) => ({
  questionId: r.id, canonicalId: r.canonical_id, version: r.version, areaId: r.enamed_area_id ?? null, topicId: r.enamed_topic_id ?? null, origin: r.origin,
  difficulty: r.difficulty, stemPreview: stemPreview(r.stem), sourceLabel: r.source_label ?? null, validation: validationOf(r), pinned,
});
async function legacyAreaCounts(tx: Parameters<Parameters<typeof run>[1]>[0], userId: string, f: ExamBuilderFilter, excluded: readonly string[] = [], pinned: readonly string[] = []) {
  const rows = await asServer<Row>(tx, sql`SELECT q.enamed_area_id area_id,count(DISTINCT ${canon})::int available,
    count(DISTINCT ${canon}) FILTER (WHERE q.id=ANY(${ids(pinned)}))::int pinned FROM question_bank q
    WHERE ${filterWhere(userId, f)} AND ${notIn(excluded)} GROUP BY 1 ORDER BY 1 NULLS LAST LIMIT 51`);
  const by = new Map(rows.map((r) => [(r.area_id as string | null) ?? null, r]));
  return (f.areaIds.length ? f.areaIds : [...by.keys()]).map((areaId): AllocationArea & { pinned: number } =>
    ({ areaId, available: Number(by.get(areaId)?.available ?? 0), pinned: Number(by.get(areaId)?.pinned ?? 0) }));
}
async function legacyAvailability(userId: string, f: ExamBuilderFilter) {
  const areas = await run(userId, (tx) => legacyAreaCounts(tx, userId, f));
  return examAvailabilitySchema.parse({ total: areas.reduce((s, a) => s + a.available, 0), areas: areas.map(({ areaId, available }) => ({ areaId, available })) });
}
async function legacyPreview(userId: string, input: { params: ExamBuilderParams; seed: string; pinnedIds: string[]; excludedIds: string[] }) {
  const { params, pinnedIds, excludedIds, seed } = input;
  return run(userId, async (tx) => {
    const areas = await legacyAreaCounts(tx, userId, params, excludedIds, pinnedIds);
    let allocation;
    try { allocation = allocateExam(areas, params.count, params.distribution); } catch { return 'pinned_exceeds_count'; }
    const needs = allocation.rows.map((r) => ({ area: r.areaId, need: r.allocated - (areas.find((a) => a.areaId === r.areaId)?.pinned ?? 0) }));
    const rows = await asServer<Row>(tx, sql`WITH e AS (SELECT DISTINCT ON (${canon}) q.id,${canon} canon,q.enamed_area_id area,q.id=ANY(${ids(pinnedIds)}) pinned
      FROM question_bank q WHERE ${filterWhere(userId, params)} AND ${notIn(excludedIds)} ORDER BY ${canon},(q.id=ANY(${ids(pinnedIds)})) DESC,q.version DESC),
      r AS (SELECT e.*,md5(${seed}||':'||e.canon::text) AS rnk,row_number() OVER (PARTITION BY e.area,e.pinned ORDER BY md5(${seed}||':'||e.canon::text),e.canon) rn FROM e)
      SELECT ${itemColumns},r.pinned FROM r JOIN jsonb_to_recordset(${JSON.stringify(needs)}::jsonb) n(area uuid,need int) ON n.area IS NOT DISTINCT FROM r.area
      JOIN question_bank q ON q.id=r.id LEFT JOIN question_sources src ON src.id=q.source_id
      WHERE r.pinned OR r.rn<=n.need
      ORDER BY ${params.shuffle ? sql`md5(${seed}||':order:'||r.canon::text)` : sql`r.area NULLS LAST,r.rnk`},r.canon`);
    return examPreviewSchema.parse({ seed, allocation, items: rows.map((r) => toItem(r, r.pinned === true)) });
  });
}

describe.skipIf(!url)('G27 perf: single-scan facets/availability/preview == legacy', () => {
  let db: typeof database.$client;
  const owner = randomUUID(), reviewer = randomUUID(), source = randomUUID(), areas = [randomUUID(), randomUUID(), randomUUID()], topics = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const papers = [randomUUID(), randomUUID(), randomUUID()], pub: string[] = [], v2: string[] = [], ai: string[] = [], all: string[] = [];
  const diffs = ['easy', 'medium', 'hard'] as const;
  const alternatives = JSON.stringify(['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, text: 'Synthetic choice ' + key })));
  async function insert(id: string, i: number, extra: { origin?: string; canonicalId?: string; version?: number; area?: string | null } = {}) {
    all.push(id);
    const area = extra.area === undefined ? areas[i % 3]! : extra.area;
    await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id,version,canonical_id,supersedes_id)
      VALUES(${id},${owner},'objective',${diffs[(i * 7) % 3]!},${'Synthetic question ' + i},${alternatives}::text::jsonb,'E','Synthetic E','student','Synthetic explanation',${extra.origin ?? 'user_authored'},
      ${area},${area === null ? null : i % 6 === 3 ? topics[3]! : topics[i % 3]!},${extra.version ?? 1},${extra.canonicalId ?? null},${extra.version ? extra.canonicalId! : null})`;
  }
  async function publish(id: string) {
    await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${source},status='approved',rights_status='authorized',integrity_confirmed=true,key_final=true,enamed_confirmed=true,content_hash=${'a'.repeat(64)},reviewed_hash=${'a'.repeat(64)},reviewer_name='Synthetic reviewer',reviewer_crm='12345-SP',reference_date='2026-10-08' WHERE id=${id}`;
    await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${reviewer},'Synthetic reviewer','12345-SP',${'a'.repeat(64)},'approved','Synthetic test only','2026-10-08')`;
    await db`UPDATE question_bank SET catalog_status='published',published_at=now(),availability='active' WHERE id=${id}`;
  }
  beforeAll(async () => {
    db = (await import('@remoa/db')).db.$client;
    for (const id of [owner, reviewer]) await db`INSERT INTO auth.users(id,email) VALUES(${id},${id + '@g27eq.example'})`;
    await db`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'Synthetic source','Synthetic','https://example.org','authorized','Synthetic test authorization')`;
    for (const id of areas) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${id},${id},'area','CM','Synthetic area')`;
    for (const [i, id] of topics.entries()) await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${id},${id},'topic','CM',${'Synthetic topic ' + i},${areas[i % 3]!})`;
    for (let i = 0; i < 45; i++) { const id = randomUUID(); pub.push(id); await insert(id, i); await publish(id); }
    // newer published versions: the root drops out (latest), the v2 carries the canonical
    for (const [i, root] of pub.slice(0, 5).entries()) { const id = randomUUID(); v2.push(id); await insert(id, i + 100, { canonicalId: root, version: 2 }); await publish(id); }
    for (let i = 0; i < 6; i++) { const id = randomUUID(); ai.push(id); await insert(id, i + 200, { origin: 'ai_generated', area: i === 5 ? null : undefined }); }
    // a private AI row sharing a public canonical (source catalog_and_ai sees both rows: distinct canonical must hold)
    { const id = randomUUID(); ai.push(id); await insert(id, 20, { origin: 'ai_generated', canonicalId: pub[20] }); }
    for (const [i, [inst, year]] of ([['Synthetic Inst', 2024], ['synthetic inst ', 2025], ['Other Inst', 2025]] as const).entries())
      await db`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${papers[i]!},${source},${'Synthetic paper ' + i},${inst},${year},${'t' + i},'A','published',true)`;
    for (const [i, q] of pub.slice(5).entries()) {
      for (const [j, p] of papers.entries()) if ((i + j) % 2 === 0) await db`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) VALUES(${p},${q},${i + 1},${String(i + 1)})`;
    }
  });
  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM exam_papers WHERE id=ANY(${papers}::uuid[])`;
    await db`DELETE FROM question_bank WHERE id=ANY(${[...v2, ...ai]}::uuid[])`; await db`DELETE FROM question_bank WHERE id=ANY(${pub}::uuid[])`;
    await db`DELETE FROM question_sources WHERE id=${source}`;
    await db`DELETE FROM enamed_taxonomy WHERE id=ANY(${topics}::uuid[])`; await db`DELETE FROM enamed_taxonomy WHERE id=ANY(${areas}::uuid[])`;
    await db`DELETE FROM auth.users WHERE id IN (${owner},${reviewer})`;
    await db.end({ timeout: 1 });
  });

  it('facets: same counts for every group combination', async () => {
    const queries = [
      {}, { areaIds: [areas[0]] }, { areaIds: [areas[0], areas[1]], difficulties: ['easy', 'hard'] }, { institutions: ['SYNTHETIC INST'] }, { years: [2025] },
      { institutions: ['Other Inst'], years: [2024], groups: 'institution,year,area' }, // same paper row: total 0, groups not { examId: papers[1], areaIds: [areas[2]] }, { topicIds: [topics[0], topics[3]], years: [2024, 2025] },
      { scope: 'catalog', difficulty: 'medium', institution: 'Synthetic Inst' }, { groups: 'topic', topicQuery: 'topic 1' }, { search: 'question 1' }, { scope: 'mine' },
    ];
    for (const raw of queries) {
      const q = questionFacetQuerySchema.parse(raw);
      const legacy = await legacyFacets(owner, q);
      expect(await questionFacets(owner, q), JSON.stringify(raw)).toEqual(legacy);
      if (!raw.groups && raw.scope !== 'mine') expect(legacy.total, JSON.stringify(raw)).toBeGreaterThan(0);
    }
  });

  it('availability: same per-area counts', async () => {
    for (const raw of [{}, { source: 'catalog_and_ai' }, { source: 'ai' }, { areaIds: [areas[1], areas[2]] }, { difficulties: ['hard'] }, { topicIds: [topics[1]] }]) {
      const f = examBuilderFilterSchema.parse(raw);
      expect(await examBuilder.availability(owner, f), JSON.stringify(raw)).toEqual(await legacyAvailability(owner, f));
    }
  });

  it('preview: identical output for the same seed (counts, distribution, shuffle, source, pinned, excluded)', async () => {
    const seeds = ['0'.repeat(32), 'f'.repeat(32), '0123456789abcdef0123456789abcdef', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'];
    const cases: { params: Record<string, unknown>; pinnedIds?: string[]; excludedIds?: string[] }[] = [
      { params: { count: 5 } }, { params: { count: 12, distribution: 'proportional' } }, { params: { count: 30, shuffle: true } }, { params: { count: 100 } },
      { params: { count: 10, source: 'catalog_and_ai' } }, { params: { count: 4, source: 'ai' } }, { params: { count: 8, areaIds: [areas[0], areas[2]] } },
      { params: { count: 9, difficulties: ['easy', 'medium'] }, pinnedIds: [pub[7]!, pub[8]!], excludedIds: [pub[9]!, v2[0]!] },
      { params: { count: 6, areaIds: [areas[1]] }, pinnedIds: [pub[1]!], excludedIds: [pub[10]!] }, // pinned superseded root: not eligible, ignored
      { params: { count: 7, source: 'catalog_and_ai' }, pinnedIds: [ai[0]!, v2[1]!], excludedIds: [ai[1]!] },
      { params: { count: 1 }, pinnedIds: [pub[11]!, pub[12]!] }, // pinned_exceeds_count
    ];
    let drawn = 0;
    for (const seed of seeds) for (const c of cases) {
      const params = examBuilderParamsSchema.parse({ mode: 'study', ...c.params }), input = { params, seed, pinnedIds: c.pinnedIds ?? [], excludedIds: c.excludedIds ?? [] };
      const legacy = await legacyPreview(owner, input);
      const current = await examBuilder.preview(owner, input).catch((e: Error) => e.message);
      expect(current, seed + ' ' + JSON.stringify(c)).toEqual(legacy);
      if (typeof legacy !== 'string') drawn += legacy.items.length;
    }
    expect(drawn).toBeGreaterThan(300);
  });
});
