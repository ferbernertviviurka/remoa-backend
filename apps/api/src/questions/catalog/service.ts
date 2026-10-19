import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { catalogAlternativesSchema, questionPublicSchema, questionUserStateSchema, examPaperPublicSchema, questionListResultSchema, questionInstitutionListSchema, examPaperListResultSchema, type ExamPaperListQuery, type QuestionListQuery, type QuestionPublic, type QuestionValidation, type QuestionUserState, type ExamPaperPublic } from '@remoa/contracts';
import { Abort, asServer, pgArray, run } from '../../db';
import { invalidate } from '../../cache';
import { presignGet } from '../../storage/storage';
export type Row = Record<string, unknown>;
export const missing = () => new Abort({ code: 'not_found', message: 'question not found' });
export const conflict = (message: string) => new Abort({ code: 'conflict', message });
export const validation = (message: string) => new Abort({ code: 'validation', message });
const secret = () => { const key = process.env.SHARE_SECRET; if (!key) throw new Error('missing SHARE_SECRET for catalog cursor'); return key; };
const filterHash = (query: QuestionListQuery) => { const filters = { ...query }; delete filters.cursor; return createHash('sha256').update(JSON.stringify(filters)).digest('hex'); };
/** F34 FR-11: `s` = the sort key of the last item (difficulty rank or topic name); absent for `recent`. `sort` is already inside the filter hash. */
export function encodeQuestionCursor(at: string, id: string, userId: string, query: QuestionListQuery, s?: string | number) {
  const data = Buffer.from(JSON.stringify({ at, id, uid: userId, filters: filterHash(query), ...(s === undefined ? {} : { s }) })).toString('base64url');
  return data + '.' + createHmac('sha256', secret()).update('f33-cursor:' + data).digest('base64url');
}
export function decodeQuestionCursor(value: string, userId: string, query: QuestionListQuery): { at: string; id: string; s?: string | number } {
  try {
    const [data, mac, extra] = value.split('.'); if (!data || !mac || extra) throw Error();
    const actual = Buffer.from(mac, 'base64url'), expected = createHmac('sha256', secret()).update('f33-cursor:' + data).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const row = JSON.parse(Buffer.from(data, 'base64url').toString()) as Row;
    if (row.uid !== userId || row.filters !== filterHash(query) || typeof row.at !== 'string' || typeof row.id !== 'string' || !/^[a-f\d-]{36}$/i.test(row.id) || Number.isNaN(Date.parse(row.at))) throw Error();
    const sorted = query.sort === 'difficulty' || query.sort === 'topic';
    if (sorted ? (query.sort === 'difficulty' ? !Number.isInteger(row.s) : typeof row.s !== 'string') : row.s !== undefined) throw Error();
    return { at: row.at, id: row.id, ...(sorted ? { s: row.s as string | number } : {}) };
  } catch { throw validation('invalid_cursor'); }
}
/** Server-only equivalent of 0059's signed-team visibility guard. Keep every signature/source/batch check.
 * Expose the membership join to the planner: a non-inlined SQL function per candidate rescans the same graph for the full count.
 * OFFSET0 fences the small eligible-source set: authorized-source statistics otherwise choose28k PK probes.
 * This predicate is only executed by asServer; authenticated RLS keeps its private UUID-only boolean helper unchanged.
 */
export const teamReadable=sql`q.visibility='public' AND q.catalog_status='published' AND q.status='approved'
 AND q.origin='official_exam' AND q.user_id IS NULL AND q.validation_kind='remoa_team_attested' AND q.rights_status='pending'
 AND EXISTS(SELECT 1 FROM question_team_items ti JOIN question_team_batches tb ON tb.id=ti.batch_id
 JOIN(SELECT ts.id FROM question_sources ts WHERE
 (ts.rights_status='pending' OR (ts.rights_status='authorized' AND ts.rights_scope='g29-cp21-20261019' AND ts.rights_evidence='Aprovado por Remoa' AND ts.rights_expires_at IS NOT NULL))
 AND (ts.rights_expires_at IS NULL OR ts.rights_expires_at>now()) OFFSET 0) ts ON ts.id=ti.source_id
 WHERE ti.question_id=q.id AND ti.content_hash=q.content_hash AND ti.content_hash=q.reviewed_hash AND ti.source_id=q.source_id AND ti.profession_code=q.profession_code
 AND tb.sealed_at IS NOT NULL AND tb.activated_at IS NOT NULL AND tb.revoked_at IS NULL)`;
/** Every server read carries this access predicate, even when using a server connection. */
export const readable = (userId: string, historical = false): SQL => sql`(
 (q.visibility = 'private' AND q.user_id = ${userId} AND q.status <> 'archived' AND q.catalog_status NOT IN ('rejected','withdrawn') AND q.availability IN (${historical ? sql`'active','annulled','superseded'` : sql`'active','annulled'`})) OR
 (q.visibility = 'public' AND q.catalog_status = 'published' AND q.status = 'approved' AND q.rights_status = 'authorized' AND (q.reviewed_hash = q.content_hash) IS TRUE AND q.availability IN (${historical ? sql`'active','annulled','superseded'` : sql`'active','annulled'`}) AND EXISTS (
   SELECT 1 FROM question_sources src WHERE src.id = q.source_id AND src.rights_status = 'authorized' AND (src.rights_expires_at IS NULL OR src.rights_expires_at > now()))) OR
 (${teamReadable})
)`;
/** A published replacement permanently supersedes selection, even if later withdrawn. Drafts never hide the published version. */
/** CCR-149 (0056): `question_superseded` holds every row a newer version supersedes (server-maintained by statement triggers). */
export const latest = sql`NOT EXISTS (SELECT 1 FROM question_superseded sup WHERE sup.question_id = q.id)`;
/** Historical warnings consider usable replacements, never an unapproved public draft. */
export const obsoleteSuccessor=sql`EXISTS(SELECT 1 FROM question_bank n WHERE coalesce(n.canonical_id,n.id)=coalesce(q.canonical_id,q.id) AND n.version>q.version AND
 ((q.visibility='private' AND n.user_id=q.user_id AND n.visibility='private' AND n.status<>'archived' AND n.catalog_status NOT IN('rejected','withdrawn') AND n.availability IN('active','annulled')) OR
 (q.visibility='public' AND n.visibility='public' AND n.catalog_status='published' AND n.status='approved' AND n.rights_status='authorized' AND n.reviewed_hash=n.content_hash AND n.availability IN('active','annulled') AND EXISTS(SELECT 1 FROM question_sources ns WHERE ns.id=n.source_id AND ns.rights_status='authorized' AND (ns.rights_expires_at IS NULL OR ns.rights_expires_at>now())))))`;
/** One bounded aggregate per selected question, hydrated after ID selection; no query per item. */
export const occurrenceProjection=sql`(SELECT jsonb_build_object('items',coalesce(jsonb_agg(e.payload),'[]'::jsonb),'total',coalesce(max(e.total),0),'truncated',coalesce(max(e.total),0)>10) FROM
 (SELECT jsonb_build_object('examId',p.id,'name',p.name,'institution',p.institution,'year',p.year,'edition',p.edition,'booklet',p.booklet,'ordinal',o.ordinal,'originalNumber',o.original_number,'sourceId',p.source_id,'sourceLabel',os.name) payload,count(*) OVER() total
 FROM exam_question_occurrences o JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources os ON os.id=p.source_id
 WHERE o.question_id=q.id AND q.visibility='public' AND p.status='published' AND os.rights_status='authorized' AND (os.rights_expires_at IS NULL OR os.rights_expires_at>now()) ORDER BY p.year DESC,p.id,o.ordinal LIMIT 10) e)`;
export const teamDisclosureProjection=sql`(SELECT jsonb_build_object('kind','remoa_team_attested','rightsStatus','pending','medicalReview',false,'difficultyAssessment','unassessed','sourceRightsStatus',tis.rights_status,'sourceApprovalBasis',CASE WHEN tis.rights_status='authorized' AND tis.rights_scope='g29-cp21-20261019' AND tis.rights_evidence='Aprovado por Remoa' AND tis.rights_expires_at IS NOT NULL THEN 'remoa_admin_attestation' ELSE 'unverified' END,'sourceRightsExpiresAt',tis.rights_expires_at,'explanationStatus',CASE WHEN q.explanation IS NULL THEN 'absent' ELSE 'source_provided' END,'professionCode',i.profession_code,'sourceAreaCodes',CASE WHEN jsonb_typeof(i.original_payload->'areas')='array' THEN i.original_payload->'areas' ELSE '[]'::jsonb END,'classificationStatus',CASE WHEN jsonb_typeof(i.original_payload->'areas')='array' AND jsonb_array_length(i.original_payload->'areas')>0 THEN 'source_tags_unreviewed' ELSE 'unclassified' END,'flags',i.flags,'resolutionEligible',q.availability='active','declarationDate','2026-10-19') FROM question_team_items i JOIN question_sources tis ON tis.id=i.source_id WHERE i.question_id=q.id AND q.validation_kind='remoa_team_attested')`;
export const publicColumns = sql`q.id, coalesce(q.canonical_id,q.id) canonical_id, q.version, q.type, q.stem, q.alternatives,
 q.origin, q.visibility, q.availability, q.difficulty, q.enamed_topic_id, q.enamed_area_id, q.source_id, q.assets, ARRAY(SELECT c.id FROM cards c WHERE c.board_id=b.id AND c.deleted_at IS NULL AND c.id=ANY(q.card_ids)) card_ids, b.id board_id,
 q.profession_code,${teamDisclosureProjection} team_disclosure,
 q.created_at, q.created_at::text cursor_at, (q.reviewed_hash IS NOT NULL AND q.reviewed_hash=q.content_hash) reviewed, q.validation_kind, q.reviewer_name validation_label,
 src.name source_label, b.title board_title,${occurrenceProjection} occurrences,
 coalesce(us.favorite,false) favorite, coalesce(us.doubtful,false) doubtful, coalesce(us.annotation,'') annotation`;
export const catalogJoins = (userId: string) => sql`LEFT JOIN question_sources src ON src.id=q.source_id
 LEFT JOIN boards b ON b.id=q.board_id AND b.user_id=${userId} AND b.archived_at IS NULL
 LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}`;
export async function publicAssets(input: unknown) {
  if (!Array.isArray(input)) return [];
  return Promise.all(input.map(async (raw: unknown) => {
    const a = (raw !== null && typeof raw === 'object' ? raw : {}) as Row;
    const url = typeof a.objectKey === 'string' ? await presignGet(a.objectKey) : a.url;
    return { id: a.id, alt: a.alt, url, provenance: a.provenance ?? null };
  }));
}
/** Reconstruct the booklet order from a reviewed occurrence, verifying its semantic key. */
export function applyOccurrence(row: Row): Row {
  if (!row.original_keys) return row;
  const original = row.original_keys as Row;
  const stored = catalogAlternativesSchema.safeParse(original.alternatives);
  const canonical = catalogAlternativesSchema.safeParse(row.alternatives);
  if (!stored.success || !canonical.success) throw conflict('invalid_exam_occurrence');
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const canonicalTexts = new Map(canonical.data.map(a => [normalize(a.text), a.key]));
  if (canonicalTexts.size !== canonical.data.length || stored.data.length !== canonical.data.length || new Set(stored.data.map(a => normalize(a.text))).size !== stored.data.length || stored.data.some(a => !canonicalTexts.has(normalize(a.text)))) throw conflict('exam_variant_content_mismatch');
  const mapping = new Map<string,string>(stored.data.map(a => [a.key, canonicalTexts.get(normalize(a.text))!]));
  if (!row.occurrence_annulled && row.availability !== 'annulled' && mapping.get(String(original.correctKey)) !== row.correct_key) throw conflict('exam_variant_key_mismatch');
  const notes = row.distractor_notes as Record<string,string> | null;
  return {...row, alternatives:stored.data,correct_key:row.occurrence_annulled || row.availability==='annulled' ? null : original.correctKey,
    distractor_notes:notes?Object.fromEntries([...mapping].filter(([,key])=>notes[key]!==undefined).map(([key,canonicalKey])=>[key,notes[canonicalKey]])):null};
}
/** D-1819 public seal: institutional = "Remoa" (never a name or CRM); medical = reviewer name. Private/unreviewed = null. */
export function validationOf(row: Row, reviewed = row.reviewed === true): QuestionValidation | null {
  if (row.visibility !== 'public' || !reviewed) return null;
  if (row.validation_kind === 'remoa_team_attested') return { kind: 'remoa_team_attested', label: 'Remoa', scope: 'team_declaration' };
  if (row.validation_kind === 'remoa_institutional') return { kind: 'remoa_institutional', label: 'Remoa' };
  const label = typeof row.validation_label === 'string' ? row.validation_label.trim() : '';
  return label ? { kind: 'medical_review', label } : null;
}
/** Reference-after-answer signature fields. Institutional: no reviewer name, never a CRM. */
export function signature(row: Row, reviewed: boolean) {
  const v = validationOf({ ...row, validation_label: row.validation_label ?? row.reviewer_name }, reviewed);
  return v && ['remoa_institutional','remoa_team_attested'].includes(v.kind) ? { reviewerName: null, reviewerCrm: null, validation: v }
    : { reviewerName: (row.reviewer_name as string | null) ?? null, reviewerCrm: (row.reviewer_crm as string | null) ?? null, validation: v };
}
export async function toQuestion(row: Row): Promise<QuestionPublic> {
  return questionPublicSchema.parse({ id: row.id, canonicalId: row.canonical_id ?? row.id, version: row.version, type: row.type, stem: row.stem, alternatives: row.alternatives,
    origin: row.origin, visibility: row.visibility, availability: row.availability, difficulty: row.difficulty, topicId: row.enamed_topic_id ?? null, areaId: row.enamed_area_id ?? null,
    sourceId: row.source_id ?? null, sourceLabel: row.source_label ?? null, occurrences:row.occurrences??{items:[],total:0,truncated:false}, reviewed: row.reviewed ?? false, validation: validationOf(row), ...(row.team_disclosure ? {teamDisclosure:row.team_disclosure}:{}), assets: await publicAssets(row.assets), cardIds: row.card_ids ?? [],
    boardId: row.board_id ?? null, boardTitle: row.board_title ?? null, userState: { favorite: row.favorite ?? false, doubtful: row.doubtful ?? false, annotation: row.annotation ?? '' }, createdAt: row.created_at });
}
export const many = <T>(plural: readonly T[] | undefined, single?: T): T[] => [...new Set([...(plural ?? []), ...(single === undefined ? [] : [single])])];
/** F34 FR-7: OR inside a group, AND across groups. The singular field ORs into its plural group. */
export type FilterGroup = 'area' | 'topic' | 'institution' | 'year' | 'difficulty';
/** Occurrence (paper) conditions of the year/institution/exam filters; they must hold on the same paper row. */
export function paperFilters(query: QuestionListQuery, omit?: FilterGroup): SQL[] {
  const f: SQL[] = [], years = omit === 'year' ? [] : many(query.years, query.year), insts = omit === 'institution' ? [] : many(query.institutions, query.institution);
  if (query.examId) f.push(sql`p.id=${query.examId}`);
  if (years.length) f.push(sql`p.year::text=ANY(${pgArray(years.map(String), 'text')})`);
  if (insts.length) f.push(sql`lower(btrim(p.institution))=ANY(ARRAY(SELECT lower(btrim(x)) FROM unnest(${pgArray(insts, 'text')}) x))`);
  return f;
}
export const paperBase = sql`p.status='published' AND ps.rights_status='authorized' AND (ps.rights_expires_at IS NULL OR ps.rights_expires_at>now())`;
export function stateJoin(userId: string, query: QuestionListQuery): SQL {
  return ['favorite', 'doubtful'].includes(query.state ?? '') ? sql`LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}` : sql``;
}
/** The owner's latest counted attempt per canonical question (same rule for the `state` filter, `progress` and the drawer's last attempt). */
export function lastAttemptsSQL(userId: string, canonicalIds?: readonly string[] | SQL, detail = false): SQL {
  return sql`SELECT DISTINCT ON (coalesce(aq.canonical_id,aq.id)) coalesce(aq.canonical_id,aq.id) canonical,
      CASE WHEN a.selected_key IS NULL THEN false ELSE a.correct END correct${detail ? sql`,a.selected_key,a.submitted_at,i.question_id,i.reference_snapshot` : sql``}
      FROM question_answers a JOIN question_session_items i ON i.id=a.item_id JOIN question_bank aq ON aq.id=i.question_id
      JOIN question_sessions sess ON sess.id=i.session_id AND sess.user_id=a.user_id
      WHERE (sess.mode='study' OR sess.status<>'active') AND aq.availability='active'
      AND coalesce((i.reference_snapshot->>'annulled')::boolean,false)=false AND a.user_id=${userId}
      ${!canonicalIds ? sql`` : Array.isArray(canonicalIds) ? sql`AND coalesce(aq.canonical_id,aq.id)=ANY(${pgArray(canonicalIds, 'uuid')})` : sql`AND coalesce(aq.canonical_id,aq.id) IN (${canonicalIds})`}
      ORDER BY coalesce(aq.canonical_id,aq.id),a.submitted_at DESC,a.id DESC`;
}
/** `omit` drops one facet group's own filter (disjunctive facet counts, FR-8). */
export function catalogWhere(userId: string, query: QuestionListQuery, activeOnly = false, omit?: FilterGroup): SQL {
  const parts: SQL[] = [readable(userId), latest];
  if (query.scope === 'mine') parts.push(sql`q.visibility='private' AND q.user_id=${userId}`);
  if (query.scope === 'catalog') parts.push(sql`q.visibility='public'`);
  // Legacy public questions without classification retain medicine; the frozen corpus carries its documentary profession.
  if (query.course) parts.push(sql`(q.visibility<>'public' OR coalesce(q.profession_code,'medicine')=${query.course})`);
  if (activeOnly) parts.push(sql`q.availability='active' AND q.type='objective'`);
  const fields = [['origin', query.origin], ['board_id', query.boardId], ['type', query.type], ['source_id', query.sourceId]] as const;
  for (const [name, value] of fields) if (value) parts.push(sql`${sql.raw('q.' + name)}=${value}`);
  const areas = omit === 'area' ? [] : many(query.areaIds, query.areaId), topics = omit === 'topic' ? [] : many(query.topicIds, query.topicId), diffs = omit === 'difficulty' ? [] : many(query.difficulties, query.difficulty);
  if (areas.length) parts.push(sql`q.enamed_area_id=ANY(${pgArray(areas, 'uuid')})`);
  if (topics.length) parts.push(sql`q.enamed_topic_id=ANY(${pgArray(topics, 'uuid')})`);
  if (diffs.length) parts.push(sql`q.difficulty::text=ANY(${pgArray(diffs, 'text')})`);
  if (query.search) parts.push(sql`q.stem ILIKE ${'%' + query.search.replace(/[\\%_]/g, '\\$&') + '%'}`);
  const pf = paperFilters(query, omit);
  if (pf.length) parts.push(sql`EXISTS(SELECT 1 FROM exam_question_occurrences o JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources ps ON ps.id=p.source_id WHERE o.question_id=q.id AND ${paperBase} AND ${sql.join(pf, sql` AND `)})`);
  if (query.state === 'favorite') parts.push(sql`us.favorite=true`);
  if (query.state === 'doubtful') parts.push(sql`us.doubtful=true`);
  if (query.state && ['unseen','answered','wrong'].includes(query.state)) {
    // Batch the owner's latest eligible attempts once; never rescan thousands of answers for each catalog row.
    const last = lastAttemptsSQL(userId);
    if (query.state === 'unseen') parts.push(sql`coalesce(q.canonical_id,q.id) NOT IN (SELECT attempt.canonical FROM (${last}) attempt)`);
    if (query.state === 'answered') parts.push(sql`coalesce(q.canonical_id,q.id) IN (SELECT attempt.canonical FROM (${last}) attempt)`);
    if (query.state === 'wrong') parts.push(sql`coalesce(q.canonical_id,q.id) IN (SELECT attempt.canonical FROM (${last}) attempt WHERE attempt.correct=false)`);
  }
  return sql.join(parts, sql` AND `);
}
export async function getQuestionRow(tx: Tx, userId: string, id: string, requireLatest = true): Promise<Row> {
  const [row] = await asServer<Row>(tx, sql`SELECT ${publicColumns} FROM question_bank q ${catalogJoins(userId)} WHERE q.id=${id} AND ${readable(userId)} ${requireLatest ? sql`AND ${latest}` : sql``}`);
  if (!row) throw missing(); return row;
}
/** Select small authorized IDs before hydrating assets/card links; a broad filter must not hydrate every matching row. */
export function catalogListSQL(userId:string,query:QuestionListQuery,cur:{at:string;id:string}|null=null):SQL{
  const stateJoin=['favorite','doubtful'].includes(query.state??'')?sql`LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}`:sql``;
  return sql`WITH selected AS MATERIALIZED (SELECT q.id FROM question_bank q ${stateJoin} WHERE ${catalogWhere(userId,query)}
    ${cur?sql`AND (q.created_at,q.id)<(${cur.at}::timestamptz,${cur.id}::uuid)`:sql``} ORDER BY q.created_at DESC,q.id DESC LIMIT ${query.limit+1})
    SELECT ${publicColumns} FROM selected JOIN question_bank q ON q.id=selected.id ${catalogJoins(userId)} ORDER BY q.created_at DESC,q.id DESC`;
}
export function catalogCountSQL(userId:string,query:QuestionListQuery):SQL{
  const stateJoin=['favorite','doubtful'].includes(query.state??'')?sql`LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}`:sql``;
  return sql`SELECT count(DISTINCT coalesce(q.canonical_id,q.id))::int total FROM question_bank q ${stateJoin} WHERE ${catalogWhere(userId,query)}`;
}
/** F34 FR-11: keyset by (sort key asc, created_at desc, id desc). `recent` has a constant key, so it is the old (created_at,id) order. */
const sortKey = (sort: QuestionListQuery['sort']) => sort === 'difficulty' ? { expr: sql`CASE q.difficulty::text WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`, join: sql``, cast: sql.raw('int') }
  : sort === 'topic' ? { expr: sql`coalesce(tp.name,chr(1114111))`, join: sql`LEFT JOIN enamed_taxonomy tp ON tp.id=q.enamed_topic_id`, cast: sql.raw('text') }
  : { expr: sql`0`, join: sql``, cast: sql.raw('int') };
/** Reuse the exact authorized ID set for pagination and the global total, including empty pages. */
export function catalogPageSQL(userId:string,query:QuestionListQuery,cur:{at:string;id:string;s?:string|number}|null=null,withProgress=false):SQL{
  const k = sortKey(query.sort), keyset = !cur ? sql`` : query.sort === 'difficulty' || query.sort === 'topic'
    ? sql`WHERE sort_key>${cur.s}::${k.cast} OR (sort_key=${cur.s}::${k.cast} AND (created_at,id)<(${cur.at}::timestamptz,${cur.id}::uuid))`
    : sql`WHERE (created_at,id)<(${cur.at}::timestamptz,${cur.id}::uuid)`;
  return sql`WITH eligible AS MATERIALIZED (SELECT q.id,coalesce(q.canonical_id,q.id) canonical_id,q.created_at,${k.expr} sort_key FROM question_bank q ${stateJoin(userId,query)} ${k.join} WHERE ${catalogWhere(userId,query)}),
    counted AS (SELECT count(DISTINCT canonical_id)::int total FROM eligible),
    selected AS (SELECT id,canonical_id,sort_key FROM eligible ${keyset} ORDER BY sort_key,created_at DESC,id DESC LIMIT ${query.limit+1})${withProgress?sql`,
    prog AS (SELECT l.canonical,l.correct FROM (${lastAttemptsSQL(userId,sql`SELECT canonical_id FROM selected`)}) l)`:sql``}
    SELECT counted.total,selected.sort_key,${withProgress?sql`prog.canonical IS NOT NULL attempted,prog.correct attempt_correct,`:sql``}${publicColumns} FROM counted LEFT JOIN selected ON true ${withProgress?sql`LEFT JOIN prog ON prog.canonical=selected.canonical_id`:sql``} LEFT JOIN question_bank q ON q.id=selected.id ${catalogJoins(userId)} ORDER BY selected.sort_key,q.created_at DESC,q.id DESC`;
}
export const questionCatalog = {
  /** `bank` = bankStudent flag. Off: the legacy list, bit for bit; the F34 filters/sort are refused (404) and no progress is computed. */
  async list(userId: string, query: QuestionListQuery, opts: { bank?: boolean } = {}) {
    const bank = opts.bank === true;
    if (!bank && (query.areaIds || query.topicIds || query.institutions || query.years || query.difficulties || query.sort)) throw new Abort({ code: 'not_found', message: 'route not found' });
    const cur = query.cursor ? decodeQuestionCursor(query.cursor, userId, query) : null;
    const { rows, total } = await run(userId, async (tx) => {
      const page = await asServer<Row>(tx,catalogPageSQL(userId,query,cur,bank));
      return { rows: page.filter(row=>row.id!==null), total: Number(page[0]?.total ?? 0) };
    });
    const more = rows.length > query.limit, selected = rows.slice(0, query.limit), last = selected.at(-1);
    const keyed = query.sort === 'difficulty' || query.sort === 'topic';
    const nextCursor = more && last && process.env.SHARE_SECRET ? encodeQuestionCursor(String(last.cursor_at),String(last.id),userId,query,keyed?(last.sort_key as string|number):undefined) : null;
    const items = await Promise.all(selected.map(async row => { const q = await toQuestion(row); return bank ? { ...q, progress: row.attempted !== true ? 'unseen' as const : row.attempt_correct === true ? 'correct' as const : 'wrong' as const } : q; }));
    return questionListResultSchema.parse({ items, total, nextCursor });
  },
  async get(userId: string, id: string) { return toQuestion(await run(userId, (tx) => getQuestionRow(tx,userId,id))); },
  async state(userId: string, id: string): Promise<QuestionUserState> {
    return run(userId, async (tx) => { const q = await getQuestionRow(tx,userId,id); return questionUserStateSchema.parse({ favorite: q.favorite, doubtful: q.doubtful, annotation: q.annotation }); });
  },
  async setState(userId: string, id: string, state: Partial<QuestionUserState>) {
    const result = await run(userId, async (tx) => {
      const q = await getQuestionRow(tx,userId,id); const [row] = await asServer<Row>(tx, sql`INSERT INTO question_user_state(user_id,question_id,favorite,doubtful,annotation)
        VALUES (${userId},${q.canonical_id},${state.favorite ?? false},${state.doubtful ?? false},${state.annotation ?? ''})
        ON CONFLICT (user_id,question_id) DO UPDATE SET favorite=coalesce(${state.favorite ?? null},question_user_state.favorite), doubtful=coalesce(${state.doubtful ?? null},question_user_state.doubtful), annotation=coalesce(${state.annotation ?? null},question_user_state.annotation),updated_at=now() RETURNING favorite,doubtful,annotation`);
      return questionUserStateSchema.parse(row);
    }); await invalidate('question.changed',{userId}); return result;
  },
  async report(userId: string, id: string, body: {version:number;type:string;description:string}) {
    await run(userId, async (tx) => { await asServer(tx,sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId+':question-reports'},33))`); const q=await getQuestionRow(tx,userId,id,false); if(q.version!==body.version)throw conflict('question_version_changed');
      const [rate]=await asServer<Row>(tx,sql`SELECT count(*)::int n FROM question_reports WHERE user_id=${userId} AND created_at>now()-interval '1 minute'`);
      if(Number(rate?.n)>4)throw new Abort({code:'rate_limited',message:'report_rate_limit'});
      await asServer(tx,sql`INSERT INTO question_reports(user_id,question_id,version,type,description) VALUES (${userId},${id},${body.version},${body.type},${body.description})`);
    }); await invalidate('question.changed',{userId}); return {reported:true as const};
  },
};
export const paperAccess = sql`p.status='published' AND src.rights_status='authorized' AND (src.rights_expires_at IS NULL OR src.rights_expires_at>now())`;
const paperCols=sql`p.id,p.name,p.institution,p.year,p.edition,p.booklet,p.source_id,p.version,p.duration_sec,p.status,p.coverage_kind,p.expected_question_count`;
export const paperScorable=sql`q.type='objective' AND q.availability='active' AND NOT o.annulled AND (q.correct_key IS NOT NULL OR o.original_keys IS NOT NULL)`;
export const toPaper=(row:Row):ExamPaperPublic=>examPaperPublicSchema.parse({id:row.id,name:row.name,institution:row.institution,year:row.year,edition:row.edition,booklet:row.booklet,sourceId:row.source_id,professionCode:row.profession_code??null,version:row.version,durationSec:row.duration_sec,questionCount:row.question_count,coverage:{kind:row.coverage_kind??'unknown',expectedQuestionCount:row.expected_question_count??null,availableQuestionCount:row.question_count,scorableQuestionCount:row.scorable_count??row.question_count},status:row.status});
/** One eligibility scan for all papers, rather than rerunning signed membership for every paper. */
export function paperCatalogSQL(userId:string,query:ExamPaperListQuery,offset:number,limit:number){
 const filters:SQL[]=[paperAccess,sql`coalesce(stats.question_count,0)>0`];
 if(query.course)filters.push(sql`stats.profession_code=${query.course}`);
 if(query.year)filters.push(sql`p.year=${query.year}`);
 if(query.institution)filters.push(sql`p.institution=${query.institution}`);
 if(query.search){const pattern='%'+query.search.replace(/[\\%_]/g,'\\$&')+'%';filters.push(sql`(p.name ILIKE ${pattern} OR p.institution ILIKE ${pattern} OR p.booklet ILIKE ${pattern})`);}
 return sql`WITH eligible_questions AS MATERIALIZED(SELECT q.id,q.type,q.availability,q.correct_key,q.profession_code FROM question_bank q WHERE ${readable(userId)} AND ${latest}), stats AS MATERIALIZED(SELECT o.paper_id,count(*)::int question_count,count(*) FILTER(WHERE ${paperScorable})::int scorable_count,CASE WHEN count(DISTINCT q.profession_code)=1 THEN min(q.profession_code) END profession_code FROM exam_question_occurrences o JOIN eligible_questions q ON q.id=o.question_id GROUP BY o.paper_id), eligible AS MATERIALIZED(SELECT ${paperCols},stats.question_count,stats.scorable_count,stats.profession_code FROM exam_papers p JOIN question_sources src ON src.id=p.source_id JOIN stats ON stats.paper_id=p.id WHERE ${sql.join(filters,sql` AND `)}), page AS(SELECT * FROM eligible ORDER BY year DESC,name,booklet,id OFFSET ${offset} LIMIT ${limit}) SELECT (SELECT count(*)::int FROM eligible) total,coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY year DESC,name,booklet,id) FROM page),'[]'::jsonb) items`;
}
function paperCursor(offset:number,userId:string,query:ExamPaperListQuery){const data=Buffer.from(JSON.stringify({offset,userId,query:{...query,cursor:undefined}})).toString('base64url');return data+'.'+createHmac('sha256',secret()).update('paper-cursor:'+data).digest('base64url');}
function paperOffset(userId:string,query:ExamPaperListQuery){if(!query.cursor)return 0;try{const[data,mac,extra]=query.cursor.split('.');if(!data||!mac||extra!==undefined||Buffer.from(data,'base64url').toString('base64url')!==data)throw Error();const expected=createHmac('sha256',secret()).update('paper-cursor:'+data).digest(),actual=Buffer.from(mac,'base64url');if(actual.toString('base64url')!==mac||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const parsed=JSON.parse(Buffer.from(data,'base64url').toString());if(parsed.userId!==userId||JSON.stringify(parsed.query)!==JSON.stringify({...query,cursor:undefined})||!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw Error();return parsed.offset as number;}catch{throw validation('invalid_cursor');}}
export const questionExams={
 async catalog(userId:string,query:ExamPaperListQuery){return run(userId,async tx=>{const offset=paperOffset(userId,query);const [page]=await asServer<Row>(tx,paperCatalogSQL(userId,query,offset,query.limit));const items=(page?.items??[]) as Row[],total=Number(page?.total??0);return examPaperListResultSchema.parse({items:items.map(toPaper),total,nextCursor:offset+items.length<total?paperCursor(offset+items.length,userId,query):null});});},
 async list(userId:string){return run(userId,async tx=>{const [page]=await asServer<Row>(tx,paperCatalogSQL(userId,{limit:100},0,200));return ((page?.items??[]) as Row[]).map(toPaper);});},
 async get(userId:string,id:string){return run(userId,async tx=>{
 const [paper]=await asServer<Row>(tx,sql`SELECT ${paperCols} FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE p.id=${id} AND ${paperAccess}`);if(!paper)throw missing();
 const rows=await asServer<Row>(tx,sql`SELECT ${publicColumns},q.correct_key,q.distractor_notes,o.original_keys,o.original_number,o.annulled occurrence_annulled,(${paperScorable}) scorable FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id ${catalogJoins(userId)} WHERE o.paper_id=${id} AND ${readable(userId)} AND ${latest} ORDER BY o.ordinal LIMIT 500`);
 const professions=new Set(rows.map(r=>r.profession_code).filter(Boolean));
 return {paper:toPaper({...paper,question_count:rows.length,scorable_count:rows.filter(r=>r.scorable).length,profession_code:professions.size===1?[...professions][0]:null}),questions:await Promise.all(rows.map(applyOccurrence).map(toQuestion))};
 });},
};

export async function getQuestionInstitutions(userId:string){return run(userId,async tx=>{
  const rows=await asServer<Row>(tx,sql`SELECT min(btrim(p.institution)) name,count(*)::int paper_count FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE ${paperAccess} AND btrim(p.institution)<>'' AND EXISTS(SELECT 1 FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id WHERE o.paper_id=p.id AND q.visibility='public' AND ${readable(userId)} AND ${latest}) GROUP BY lower(btrim(p.institution)) ORDER BY lower(btrim(p.institution)) LIMIT 501`);
  return questionInstitutionListSchema.parse({items:rows.slice(0,500).map(r=>({name:r.name,paperCount:r.paper_count})),truncated:rows.length>500});
});}
