import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { accountQuestionsExportSchema } from '@remoa/contracts';
import { asServer } from '../../db';
import { headObject, presignGet } from '../../storage/storage';

type Row = Record<string, unknown>;
/** No wildcard projection: adding a secret column cannot silently expand an account export. */
export async function collectQuestionExport(tx: Tx, userId: string) {
  const ownedQuestions = await asServer<Row>(tx, sql`SELECT id,user_id "userId",coalesce(canonical_id,id) "canonicalId",version,visibility,origin,difficulty,board_version "boardVersion",card_ids "cardIds",evidences,prompt_id "promptId",prompt_version "promptVersion",model,status,enamed_area_id "areaId",enamed_domain_id "domainId",enamed_competency_id "competencyId",enamed_topic_id "topicId",stats,distractor_notes "distractorNotes",assets "rawAssets",board_id "boardId",type,stem,alternatives,correct_key "correctKey",expected_answer "expectedAnswer",explanation,key_points "keyPoints",created_at "createdAt",updated_at "updatedAt" FROM question_bank WHERE user_id=${userId} AND visibility='private' AND origin IN ('ai_generated','user_authored') ORDER BY created_at,id`);
  const generationReceipts = await asServer<Row>(tx, sql`SELECT id,user_id "userId",producer,status,model,provider,prompt_id "promptId",prompt_version "promptVersion",board_id "boardId",board_version "boardVersion",received_count "receivedCount",null::text "receiptText",cost_cents "costCents",error_code "errorCode",created_at "createdAt",CASE WHEN status='provider_failed' AND payload_hash IS NULL THEN NULL ELSE payload_object_key END "rawKey" FROM question_generation_runs WHERE user_id=${userId} ORDER BY created_at,id`);
  const candidates = await asServer<Row>(tx, sql`SELECT c.id,c.run_id "runId",c.ordinal,c.state,c.reason_code "reasonCode",c.question_id "questionId",c.payload_object_key "rawKey" FROM question_generation_candidates c JOIN question_generation_runs r ON r.id=c.run_id WHERE r.user_id=${userId} ORDER BY c.run_id,c.ordinal`);
  const sessions = await asServer<Row>(tx, sql`SELECT s.id,s.user_id "userId",s.mode,s.status,s.started_at "startedAt",s.deadline,s.finished_at "finishedAt",CASE WHEN s.status='active' OR s.report IS NULL OR NOT (s.report ?& ARRAY['correct','incorrect','unanswered','annulled','denominator','score']) THEN NULL ELSE jsonb_build_object('correct',s.report->'correct','incorrect',s.report->'incorrect','unanswered',s.report->'unanswered','annulled',s.report->'annulled','denominator',s.report->'denominator','score',s.report->'score') END result,(SELECT count(*)::int FROM question_session_items i WHERE i.session_id=s.id AND i.user_id=${userId}) count,(SELECT count(*)::int FROM question_session_items i WHERE i.session_id=s.id AND i.user_id=${userId} AND i.answered) "answeredCount" FROM question_sessions s WHERE s.user_id=${userId} ORDER BY s.started_at,s.id`);
  const answers = await asServer<Row>(tx, sql`SELECT a.id,a.user_id "userId",a.session_id "sessionId",a.item_id "itemId",i.question_id "questionId",a.selected_key "selectedKey",a.revision,a.elapsed_ms "elapsedMs",a.submitted_at "submittedAt" FROM question_answers a JOIN question_session_items i ON i.id=a.item_id AND i.session_id=a.session_id AND i.user_id=a.user_id WHERE a.user_id=${userId} AND i.user_id=${userId} ORDER BY a.submitted_at,a.id`);
  const userStates = await asServer<Row>(tx, sql`SELECT user_id "userId",question_id "questionId",favorite,doubtful,annotation,updated_at "updatedAt" FROM question_user_state WHERE user_id=${userId} ORDER BY question_id`);
  const reports = await asServer<Row>(tx, sql`SELECT id,user_id "userId",question_id "questionId",version,type,description,status,created_at "createdAt",updated_at "updatedAt" FROM question_reports WHERE user_id=${userId} ORDER BY created_at,id`);
  return { ownedQuestions, generationReceipts, candidates, sessions, answers, userStates, reports };
}

export const personalQuestionPrefix = (owner: string) => `questions/generation/${owner}/`;
export function isOwnedRawKey(owner: string, run: string, key: string) {
  return key.startsWith(`${personalQuestionPrefix(owner)}${run}/`) && !key.split('/').some(part => part === '..' || part === '.' || part === '') && !/[\\\u0000-\u001f]/u.test(key);
}
export function isOwnedAssetKey(owner:string,key:string){
  return typeof key==='string' && [`assets/${owner}/`,`uploads/${owner}/`,personalQuestionPrefix(owner)].some(p=>key.startsWith(p)) && !key.split('/').some(p=>p==='.'||p==='..'||p==='') && !/[\\\u0000-\u001f]/u.test(key);
}
type Storage = { head: typeof headObject; sign: typeof presignGet };
/** Signing runs after the account transaction closes; storage failure is visible, never an empty export. */
export async function finishQuestionExport(data: Awaited<ReturnType<typeof collectQuestionExport>>, owner: string, storage: Storage = { head: headObject, sign: presignGet }) {
  const cache = new Map<string, Promise<{url: string; expiresAt: Date}>>();
  async function download(key:string,missing:string){
    let exists:Awaited<ReturnType<typeof headObject>>;
    try{exists=await storage.head(key);}catch{throw new Error('question_export_storage_unavailable');}
    if(!exists)throw new Error(missing);
    try{return {url:await storage.sign(key),expiresAt:new Date(Date.now()+3600_000)};}catch{throw new Error('question_export_storage_unavailable');}
  }
  async function raw(run: string, key: unknown) {
    if (key === null) return null;
    if (typeof key !== 'string' || !isOwnedRawKey(owner,run,key)) throw new Error('question_export_raw_owner_mismatch');
    if (!cache.has(key)) cache.set(key,download(key,'question_export_raw_missing'));
    return cache.get(key)!;
  }
  const generationReceipts = [];
  for (const row of data.generationReceipts) {
    const {rawKey,...receipt}=row;
    const candidates=[];
    for (const candidate of data.candidates.filter(c=>c.runId===row.id)) {
      const {runId: _run,rawKey:key,...metadata}=candidate; void _run;
      candidates.push({...metadata,rawDownload:await raw(String(row.id),key)});
    }
    generationReceipts.push({...receipt,candidates,rawDownload:await raw(String(row.id),rawKey)});
  }
  const ownedQuestions=[];
  for(const row of data.ownedQuestions){
    const {rawAssets,...question}=row;
    const assets=[];
    for(const asset of Array.isArray(rawAssets)?rawAssets:[]){
      const a=asset as {id:string;alt:string;objectKey:string};
      if(!isOwnedAssetKey(owner,a.objectKey))throw new Error('question_export_asset_owner_mismatch');
      assets.push({id:a.id,alt:a.alt,download:await download(a.objectKey,'question_export_asset_missing')});
    }
    ownedQuestions.push({...question,assets});
  }
  return accountQuestionsExportSchema.parse({ownedQuestions,generationReceipts,sessions:data.sessions,answers:data.answers,userStates:data.userStates,reports:data.reports});
}
