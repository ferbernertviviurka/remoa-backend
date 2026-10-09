import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { catalogAlternativesSchema, questionPublicSchema, questionUserStateSchema, examPaperPublicSchema, questionListResultSchema, questionInstitutionListSchema, type QuestionListQuery, type QuestionPublic, type QuestionUserState, type ExamPaperPublic } from '@remoa/contracts';
import { Abort, asServer, run } from '../../db';
import { invalidate } from '../../cache';
import { presignGet } from '../../storage/storage';
export type Row = Record<string, unknown>;
export const missing = () => new Abort({ code: 'not_found', message: 'question not found' });
export const conflict = (message: string) => new Abort({ code: 'conflict', message });
export const validation = (message: string) => new Abort({ code: 'validation', message });
const secret = () => { const key = process.env.SHARE_SECRET; if (!key) throw new Error('missing SHARE_SECRET for catalog cursor'); return key; };
const filterHash = (query: QuestionListQuery) => { const filters = { ...query }; delete filters.cursor; return createHash('sha256').update(JSON.stringify(filters)).digest('hex'); };
export function encodeQuestionCursor(at: string, id: string, userId: string, query: QuestionListQuery) {
  const data = Buffer.from(JSON.stringify({ at, id, uid: userId, filters: filterHash(query) })).toString('base64url');
  return data + '.' + createHmac('sha256', secret()).update('f33-cursor:' + data).digest('base64url');
}
export function decodeQuestionCursor(value: string, userId: string, query: QuestionListQuery): { at: string; id: string } {
  try {
    const [data, mac, extra] = value.split('.'); if (!data || !mac || extra) throw Error();
    const actual = Buffer.from(mac, 'base64url'), expected = createHmac('sha256', secret()).update('f33-cursor:' + data).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const row = JSON.parse(Buffer.from(data, 'base64url').toString()) as Row;
    if (row.uid !== userId || row.filters !== filterHash(query) || typeof row.at !== 'string' || typeof row.id !== 'string' || !/^[a-f\d-]{36}$/i.test(row.id) || Number.isNaN(Date.parse(row.at))) throw Error();
    return { at: row.at, id: row.id };
  } catch { throw validation('invalid_cursor'); }
}
/** Every server read carries this access predicate, even when using a server connection. */
export const readable = (userId: string, historical = false): SQL => sql`(
 (q.visibility = 'private' AND q.user_id = ${userId} AND q.status <> 'archived' AND q.catalog_status NOT IN ('rejected','withdrawn') AND q.availability IN (${historical ? sql`'active','annulled','superseded'` : sql`'active','annulled'`})) OR
 (q.visibility = 'public' AND q.catalog_status = 'published' AND q.status = 'approved' AND q.rights_status = 'authorized' AND (q.reviewed_hash = q.content_hash) IS TRUE AND q.availability IN (${historical ? sql`'active','annulled','superseded'` : sql`'active','annulled'`}) AND EXISTS (
   SELECT 1 FROM question_sources src WHERE src.id = q.source_id AND src.rights_status = 'authorized' AND (src.rights_expires_at IS NULL OR src.rights_expires_at > now())))
)`;
/** A published replacement permanently supersedes selection, even if later withdrawn. Drafts never hide the published version. */
export const latest = sql`NOT EXISTS (SELECT 1 FROM question_bank newer WHERE coalesce(newer.canonical_id,newer.id) = coalesce(q.canonical_id,q.id)
 AND (newer.version > q.version OR (newer.version = q.version AND (newer.created_at,newer.id) > (q.created_at,q.id)))
 AND ((q.visibility='private' AND newer.user_id=q.user_id) OR (q.visibility='public' AND newer.visibility='public' AND (newer.published_at IS NOT NULL OR newer.catalog_status='published'))))`;
/** Historical warnings consider usable replacements, never an unapproved public draft. */
export const obsoleteSuccessor=sql`EXISTS(SELECT 1 FROM question_bank n WHERE coalesce(n.canonical_id,n.id)=coalesce(q.canonical_id,q.id) AND n.version>q.version AND
 ((q.visibility='private' AND n.user_id=q.user_id AND n.visibility='private' AND n.status<>'archived' AND n.catalog_status NOT IN('rejected','withdrawn') AND n.availability IN('active','annulled')) OR
 (q.visibility='public' AND n.visibility='public' AND n.catalog_status='published' AND n.status='approved' AND n.rights_status='authorized' AND n.reviewed_hash=n.content_hash AND n.availability IN('active','annulled') AND EXISTS(SELECT 1 FROM question_sources ns WHERE ns.id=n.source_id AND ns.rights_status='authorized' AND (ns.rights_expires_at IS NULL OR ns.rights_expires_at>now())))))`;
/** One bounded aggregate per selected question, hydrated after ID selection; no query per item. */
export const occurrenceProjection=sql`(SELECT jsonb_build_object('items',coalesce(jsonb_agg(e.payload),'[]'::jsonb),'total',coalesce(max(e.total),0),'truncated',coalesce(max(e.total),0)>10) FROM
 (SELECT jsonb_build_object('examId',p.id,'name',p.name,'institution',p.institution,'year',p.year,'edition',p.edition,'booklet',p.booklet,'ordinal',o.ordinal,'originalNumber',o.original_number,'sourceId',p.source_id,'sourceLabel',os.name) payload,count(*) OVER() total
 FROM exam_question_occurrences o JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources os ON os.id=p.source_id
 WHERE o.question_id=q.id AND q.visibility='public' AND p.status='published' AND os.rights_status='authorized' AND (os.rights_expires_at IS NULL OR os.rights_expires_at>now()) ORDER BY p.year DESC,p.id,o.ordinal LIMIT 10) e)`;
export const publicColumns = sql`q.id, coalesce(q.canonical_id,q.id) canonical_id, q.version, q.type, q.stem, q.alternatives,
 q.origin, q.visibility, q.availability, q.difficulty, q.enamed_topic_id, q.enamed_area_id, q.source_id, q.assets, ARRAY(SELECT c.id FROM cards c WHERE c.board_id=b.id AND c.deleted_at IS NULL AND c.id=ANY(q.card_ids)) card_ids, b.id board_id,
 q.created_at, q.created_at::text cursor_at, (q.reviewed_hash IS NOT NULL AND q.reviewed_hash=q.content_hash) reviewed,
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
export async function toQuestion(row: Row): Promise<QuestionPublic> {
  return questionPublicSchema.parse({ id: row.id, canonicalId: row.canonical_id ?? row.id, version: row.version, type: row.type, stem: row.stem, alternatives: row.alternatives,
    origin: row.origin, visibility: row.visibility, availability: row.availability, difficulty: row.difficulty, topicId: row.enamed_topic_id ?? null, areaId: row.enamed_area_id ?? null,
    sourceId: row.source_id ?? null, sourceLabel: row.source_label ?? null, occurrences:row.occurrences??{items:[],total:0,truncated:false}, reviewed: row.reviewed ?? false, assets: await publicAssets(row.assets), cardIds: row.card_ids ?? [],
    boardId: row.board_id ?? null, boardTitle: row.board_title ?? null, userState: { favorite: row.favorite ?? false, doubtful: row.doubtful ?? false, annotation: row.annotation ?? '' }, createdAt: row.created_at });
}
export function catalogWhere(userId: string, query: QuestionListQuery, activeOnly = false): SQL {
  const parts: SQL[] = [readable(userId), latest];
  if (query.scope === 'mine') parts.push(sql`q.visibility='private' AND q.user_id=${userId}`);
  if (query.scope === 'catalog') parts.push(sql`q.visibility='public'`);
  if (activeOnly) parts.push(sql`q.availability='active' AND q.type='objective'`);
  const fields = [['origin', query.origin], ['board_id', query.boardId], ['type', query.type], ['enamed_topic_id', query.topicId], ['enamed_area_id', query.areaId], ['source_id', query.sourceId], ['difficulty', query.difficulty]] as const;
  for (const [name, value] of fields) if (value) parts.push(sql`${sql.raw('q.' + name)}=${value}`);
  if (query.search) parts.push(sql`q.stem ILIKE ${'%' + query.search.replace(/[\\%_]/g, '\\$&') + '%'}`);
  if(query.examId || query.year || query.institution){
    const paperFilters:SQL[]=[sql`p.status='published' AND ps.rights_status='authorized' AND (ps.rights_expires_at IS NULL OR ps.rights_expires_at>now())`];
    if(query.examId)paperFilters.push(sql`p.id=${query.examId}`);
    if(query.year)paperFilters.push(sql`p.year=${query.year}`);
    if(query.institution)paperFilters.push(sql`lower(btrim(p.institution))=lower(${query.institution})`);
    parts.push(sql`EXISTS(SELECT 1 FROM exam_question_occurrences o JOIN exam_papers p ON p.id=o.paper_id JOIN question_sources ps ON ps.id=p.source_id WHERE o.question_id=q.id AND ${sql.join(paperFilters,sql` AND `)})`);
  }
  if (query.state === 'favorite') parts.push(sql`us.favorite=true`);
  if (query.state === 'doubtful') parts.push(sql`us.doubtful=true`);
  if (query.state && ['unseen','answered','wrong'].includes(query.state)) {
    // Batch the owner's latest eligible attempts once; never rescan thousands of answers for each catalog row.
    const last = sql`SELECT DISTINCT ON (coalesce(aq.canonical_id,aq.id)) coalesce(aq.canonical_id,aq.id) canonical,
      CASE WHEN a.selected_key IS NULL THEN false ELSE a.correct END correct
      FROM question_answers a JOIN question_session_items i ON i.id=a.item_id JOIN question_bank aq ON aq.id=i.question_id
      JOIN question_sessions sess ON sess.id=i.session_id AND sess.user_id=a.user_id
      WHERE (sess.mode='study' OR sess.status<>'active') AND aq.availability='active'
      AND coalesce((i.reference_snapshot->>'annulled')::boolean,false)=false AND a.user_id=${userId}
      ORDER BY coalesce(aq.canonical_id,aq.id),a.submitted_at DESC,a.id DESC`;
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
/** Reuse the exact authorized ID set for pagination and the global total, including empty pages. */
export function catalogPageSQL(userId:string,query:QuestionListQuery,cur:{at:string;id:string}|null=null):SQL{
  const stateJoin=['favorite','doubtful'].includes(query.state??'')?sql`LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}`:sql``;
  return sql`WITH eligible AS MATERIALIZED (SELECT q.id,coalesce(q.canonical_id,q.id) canonical_id,q.created_at FROM question_bank q ${stateJoin} WHERE ${catalogWhere(userId,query)}),
    counted AS (SELECT count(DISTINCT canonical_id)::int total FROM eligible),
    selected AS (SELECT id FROM eligible ${cur?sql`WHERE (created_at,id)<(${cur.at}::timestamptz,${cur.id}::uuid)`:sql``} ORDER BY created_at DESC,id DESC LIMIT ${query.limit+1})
    SELECT counted.total,${publicColumns} FROM counted LEFT JOIN selected ON true LEFT JOIN question_bank q ON q.id=selected.id ${catalogJoins(userId)} ORDER BY q.created_at DESC,q.id DESC`;
}
export const questionCatalog = {
  async list(userId: string, query: QuestionListQuery) {
    const cur = query.cursor ? decodeQuestionCursor(query.cursor, userId, query) : null;
    const { rows, total } = await run(userId, async (tx) => {
      const page = await asServer<Row>(tx,catalogPageSQL(userId,query,cur));
      return { rows:page.filter(row=>row.id!==null), total: Number(page[0]?.total ?? 0) };
    });
    const more = rows.length > query.limit, selected = rows.slice(0, query.limit), last = selected.at(-1);
    return questionListResultSchema.parse({ items: await Promise.all(selected.map(toQuestion)), total, nextCursor: more && last ? encodeQuestionCursor(String(last.cursor_at),String(last.id),userId,query) : null });
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
const paperCols=sql`p.id,p.name,p.institution,p.year,p.edition,p.booklet,p.source_id,p.version,p.duration_sec,p.status`;
export const toPaper=(row:Row):ExamPaperPublic=>examPaperPublicSchema.parse({id:row.id,name:row.name,institution:row.institution,year:row.year,edition:row.edition,booklet:row.booklet,sourceId:row.source_id,version:row.version,durationSec:row.duration_sec,questionCount:row.question_count,status:row.status});
export const questionExams={
  async list(userId:string){return run(userId,async(tx)=>{
    const rows=await asServer<Row>(tx,sql`SELECT ${paperCols},(SELECT count(*)::int FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id WHERE o.paper_id=p.id AND ${readable(userId)}) question_count FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE ${paperAccess} ORDER BY p.year DESC,p.name,p.booklet LIMIT 200`);return rows.map(toPaper);
  });},
  async get(userId:string,id:string){return run(userId,async(tx)=>{
    const [paper]=await asServer<Row>(tx,sql`SELECT ${paperCols} FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE p.id=${id} AND ${paperAccess}`);if(!paper)throw missing();
    const rows=await asServer<Row>(tx,sql`SELECT ${publicColumns},q.correct_key,q.distractor_notes,o.original_keys,o.annulled occurrence_annulled FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id ${catalogJoins(userId)} WHERE o.paper_id=${id} AND ${readable(userId)} ORDER BY o.ordinal LIMIT 500`);
    return {paper:toPaper({...paper,question_count:rows.length}),questions:await Promise.all(rows.map(applyOccurrence).map(toQuestion))};
  });},
};

export async function getQuestionInstitutions(userId:string){return run(userId,async tx=>{
  const rows=await asServer<Row>(tx,sql`SELECT min(btrim(p.institution)) name,count(*)::int paper_count FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE ${paperAccess} AND btrim(p.institution)<>'' AND EXISTS(SELECT 1 FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id WHERE o.paper_id=p.id AND q.visibility='public' AND ${readable(userId)} AND ${latest}) GROUP BY lower(btrim(p.institution)) ORDER BY lower(btrim(p.institution)) LIMIT 501`);
  return questionInstitutionListSchema.parse({items:rows.slice(0,500).map(r=>({name:r.name,paperCount:r.paper_count})),truncated:rows.length>500});
});}
