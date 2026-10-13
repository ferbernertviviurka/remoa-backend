/**
 * F34 / G27 exam builder (FR-24..28, D-1825): availability, preview, swap and revalidate. Read-only, never a draw on its own:
 * the session is created by POST /v1/question-sessions with questionIds + builder (sessions/service.ts).
 * Answer-key rule (D-1822): no query here selects correct_key, explanation, distractor notes or alternatives.
 */
import { randomBytes } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import {
  allocateExam, examAvailabilitySchema, examPreviewSchema, examRevalidateResultSchema, examSwapResultSchema, questionListQuerySchema,
  type AllocationArea, type ExamBuilderFilter, type ExamBuilderParams, type ExamRevalidateResult,
} from '@remoa/contracts';
import { asServer, pgArray, run } from '../../db';
import { catalogWhere, conflict, missing, readable, validation, validationOf, type Row } from '../catalog/service';

type Source = ExamBuilderFilter['source'];
const ids = (xs: readonly string[]) => pgArray(xs, 'uuid');
const canon = sql`coalesce(q.canonical_id,q.id)`;
/** D-1823: the catalog is public only; "ai" is the caller's own private ai_generated questions; both only by explicit choice. */
export function sourceWhere(userId: string, source: Source): SQL {
  const ai = sql`(q.visibility='private' AND q.user_id=${userId} AND q.origin='ai_generated')`;
  return source === 'catalog' ? sql`q.visibility='public'` : source === 'ai' ? ai : sql`(q.visibility='public' OR ${ai})`;
}
/** Readable now, latest version, active, objective, inside the source (+ the owner's progress filter). */
export function eligibleWhere(userId: string, source: Source, progress: ExamBuilderFilter['progress'] = 'all'): SQL {
  return sql`${catalogWhere(userId, questionListQuerySchema.parse(progress === 'all' ? {} : { state: progress }), true)} AND ${sourceWhere(userId, source)}`;
}
function filterWhere(userId: string, f: ExamBuilderFilter): SQL {
  const parts = [eligibleWhere(userId, f.source, f.progress)];
  if (f.areaIds.length) parts.push(sql`q.enamed_area_id=ANY(${ids(f.areaIds)})`);
  // FR-37: topics and map matrix items both resolve to taxonomy nodes and their descendants (one OR group).
  if (f.topicIds.length || f.matrixItemIds.length) parts.push(sql`q.enamed_topic_id IN (WITH RECURSIVE t AS (
    SELECT id FROM enamed_taxonomy WHERE id=ANY(${ids(f.topicIds)}) OR matrix_ref=ANY(${ids(f.matrixItemIds)})
    UNION SELECT c.id FROM enamed_taxonomy c JOIN t ON c.parent_id=t.id) SELECT id FROM t)`);
  if (f.difficulties.length) parts.push(sql`q.difficulty::text=ANY(${pgArray(f.difficulties, 'text')})`);
  return sql.join(parts, sql` AND `);
}
/** Excludes the ids and every version of their canonical question (distinct canonical). */
const notIn = (xs: readonly string[]) => xs.length
  ? sql`q.id<>ALL(${ids(xs)}) AND ${canon} NOT IN (SELECT coalesce(x.canonical_id,x.id) FROM question_bank x WHERE x.id=ANY(${ids(xs)}))` : sql`true`;
const rank = (seed: string) => sql`md5(${seed}||':'||${canon}::text)`;
const itemColumns = sql`q.id,${canon} canonical_id,q.version,q.enamed_area_id,q.enamed_topic_id,q.origin,q.difficulty,q.stem,q.visibility,q.validation_kind,
  q.reviewer_name validation_label,(q.reviewed_hash IS NOT NULL AND q.reviewed_hash=q.content_hash) reviewed,src.name source_label`;
export function stemPreview(stem: unknown): string {
  const text = String(stem ?? '').replace(/\s+/g, ' ').trim();
  return !text ? '…' : text.length <= 280 ? text : text.slice(0, 279) + '…';
}
const toItem = (r: Row, pinned: boolean) => ({
  questionId: r.id, canonicalId: r.canonical_id, version: r.version, areaId: r.enamed_area_id ?? null, topicId: r.enamed_topic_id ?? null, origin: r.origin,
  difficulty: r.difficulty, stemPreview: stemPreview(r.stem), sourceLabel: r.source_label ?? null, validation: validationOf(r), pinned,
});
/** Distinct canonical per area = number of (area, canonical) groups: hash aggregates, no sort of every eligible row. */
const areaCountsSQL = (rows: SQL) => sql`SELECT area area_id,count(*)::int available,count(*) FILTER (WHERE p)::int pinned
    FROM (SELECT area,canon,bool_or(pinned) p FROM ${rows} GROUP BY 1,2) x GROUP BY 1 ORDER BY 1 NULLS LAST LIMIT 51`;
/** The eligible rows of a filter, narrow (no stem, no key): id, canonical, area, pinned, version. */
const eligibleRows = (userId: string, f: ExamBuilderFilter, excluded: readonly string[], pinned: readonly string[]) =>
  sql`SELECT q.id,${canon} canon,q.enamed_area_id area,q.id=ANY(${ids(pinned)}) pinned,q.version FROM question_bank q WHERE ${filterWhere(userId, f)} AND ${notIn(excluded)}`;
function toAreas(f: ExamBuilderFilter, rows: Row[]) {
  const by = new Map(rows.map((r) => [(r.area_id as string | null) ?? null, r]));
  // Chosen areas always appear (0 = shortfall per area); otherwise every area with something available.
  return (f.areaIds.length ? f.areaIds : [...by.keys()]).map((areaId): AllocationArea & { pinned: number } =>
    ({ areaId, available: Number(by.get(areaId)?.available ?? 0), pinned: Number(by.get(areaId)?.pinned ?? 0) }));
}
/** Per-request revalidation (also used by the session start): ok / newer published version / gone. */
export async function recheck(tx: Tx, userId: string, source: Source, questionIds: readonly string[]): Promise<ExamRevalidateResult> {
  const rows = await asServer<Row>(tx, sql`SELECT o.id,l.id latest_id FROM question_bank o LEFT JOIN LATERAL (SELECT q.id FROM question_bank q
    WHERE coalesce(q.canonical_id,q.id)=coalesce(o.canonical_id,o.id) AND ${eligibleWhere(userId, source)} ORDER BY q.version DESC,q.id LIMIT 1) l ON true
    WHERE o.id=ANY(${ids(questionIds)})`);
  const latest = new Map(rows.map((r) => [String(r.id), r.latest_id == null ? null : String(r.latest_id)]));
  const unavailable: string[] = [], updated: { id: string; latestId: string }[] = [];
  for (const id of questionIds) {
    const l = latest.get(id);
    if (!l) unavailable.push(id); else if (l !== id) updated.push({ id, latestId: l });
  }
  return examRevalidateResultSchema.parse({ ok: !unavailable.length && !updated.length, unavailable, updated });
}

export const examBuilder = {
  async availability(userId: string, f: ExamBuilderFilter) {
    const rows = await run(userId, (tx) => asServer<Row>(tx, areaCountsSQL(sql`(${eligibleRows(userId, f, [], [])}) e`)));
    const areas = toAreas(f, rows);
    return examAvailabilitySchema.parse({ total: areas.reduce((s, a) => s + a.available, 0), areas: areas.map(({ areaId, available }) => ({ areaId, available })) });
  },
  /**
   * G27 perf: ONE scan of the eligible set gives the per-area counts, the pinned rows and, per area, the first `count` candidates in
   * md5(seed||':'||canonical) order (distinct canonical: a pinned version wins, then the newest). The allocation is computed here and
   * the chosen ids are hydrated by primary key. Same output as the two-scan version for the same seed (equivalence.integration.test).
   */
  async preview(userId: string, input: { params: ExamBuilderParams; seed?: string; pinnedIds: string[]; excludedIds: string[] }) {
    const { params, pinnedIds, excludedIds } = input, seed = input.seed ?? randomBytes(16).toString('hex');
    return run(userId, async (tx) => {
      const [scan] = await asServer<{ counts: Row[] | null; candidates: Row[] | null }>(tx, sql`WITH e AS MATERIALIZED (${eligibleRows(userId, params, excludedIds, pinnedIds)}),
        d AS MATERIALIZED (SELECT DISTINCT ON (canon) id,canon,area,pinned,md5(${seed}||':'||canon::text) rnk FROM e ORDER BY canon,pinned DESC,version DESC),
        -- top-N per area (bounded heap sort), never a full sort of the eligible set; rn = rank inside (area, not pinned)
        r AS (SELECT t.id,t.canon,t.area,false pinned,row_number() OVER (PARTITION BY t.area ORDER BY t.rnk,t.canon) rn FROM (SELECT DISTINCT area FROM d) a
          CROSS JOIN LATERAL (SELECT * FROM d WHERE d.area IS NOT DISTINCT FROM a.area AND NOT d.pinned ORDER BY d.rnk,d.canon LIMIT ${params.count}) t
          UNION ALL SELECT id,canon,area,true,0 FROM d WHERE pinned)
        SELECT (SELECT jsonb_agg(to_jsonb(c)) FROM (${areaCountsSQL(sql`e`)}) c) counts,
          (SELECT jsonb_agg(jsonb_build_object('id',id,'canon',canon,'area',area,'pinned',pinned,'rn',rn)) FROM r) candidates`);
      const areas = toAreas(params, scan?.counts ?? []);
      let allocation;
      try { allocation = allocateExam(areas, params.count, params.distribution); } catch { throw validation('pinned_exceeds_count'); }
      const needs = new Map(allocation.rows.map((r) => [r.areaId, r.allocated - (areas.find((a) => a.areaId === r.areaId)?.pinned ?? 0)]));
      // Pinned (still eligible) stay; the rest of each area comes in md5(seed||':'||canonical_id) order (D-1825). Never completes a shortfall.
      const chosen = (scan?.candidates ?? []).filter((c) => { const need = needs.get((c.area as string | null) ?? null); return need !== undefined && (c.pinned === true || Number(c.rn) <= need); })
        .map(({ id, canon, area, pinned }) => ({ id, canon, area, pinned }));
      const rows = !chosen.length ? [] : await asServer<Row>(tx, sql`SELECT ${itemColumns},x.pinned FROM jsonb_to_recordset(${JSON.stringify(chosen)}::jsonb) x(id uuid,canon uuid,area uuid,pinned boolean)
        JOIN question_bank q ON q.id=x.id LEFT JOIN question_sources src ON src.id=q.source_id WHERE ${readable(userId)}
        ORDER BY ${params.shuffle ? sql`md5(${seed}||':order:'||x.canon::text)` : sql`x.area NULLS LAST,md5(${seed}||':'||x.canon::text)`},x.canon`);
      return examPreviewSchema.parse({ seed, allocation, items: rows.map((r) => toItem(r, r.pinned === true)) });
    });
  },
  async swap(userId: string, input: { params: ExamBuilderParams; seed: string; questionId: string; currentIds: string[]; excludedIds: string[] }) {
    return run(userId, async (tx) => {
      const [current] = await asServer<Row>(tx, sql`SELECT q.enamed_area_id area FROM question_bank q WHERE q.id=${input.questionId} AND ${readable(userId, true)}`);
      if (!current) throw missing();
      const [row] = await asServer<Row>(tx, sql`SELECT ${itemColumns} FROM question_bank q LEFT JOIN question_sources src ON src.id=q.source_id
        WHERE ${filterWhere(userId, input.params)} AND q.enamed_area_id IS NOT DISTINCT FROM ${current.area ?? null}::uuid
        AND ${notIn([...new Set([input.questionId, ...input.currentIds, ...input.excludedIds])])} ORDER BY ${rank(input.seed)},${canon} LIMIT 1`);
      if (!row) throw conflict('no_replacement');
      return examSwapResultSchema.parse({ item: toItem(row, false) });
    });
  },
  async revalidate(userId: string, input: { params: ExamBuilderParams; questionIds: string[] }) {
    return run(userId, (tx) => recheck(tx, userId, input.params.source, input.questionIds));
  },
};
