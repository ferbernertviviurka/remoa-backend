import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import {
  catalogAlternativeKeys, questionAnswerSavedSchema, questionListQuerySchema,
  questionReferenceAfterAnswerSchema, questionSessionPublicSchema, questionSessionReportSchema,questionSessionSummaryPublicSchema,
  type QuestionAnswerInput, type QuestionPublic, type QuestionReferenceAfterAnswer, type QuestionSessionConfig, type QuestionSessionReport,type QuestionListQuery,
} from '@remoa/contracts';
import { asServer, pgArray, run } from '../../db';
import { invalidate } from '../../cache';
import { withTiming } from '../../perf';
import { applyOccurrence, catalogJoins, catalogWhere, conflict, missing, obsoleteSuccessor, paperAccess, publicAssets, publicColumns, readable, toQuestion, validation, type Row } from '../catalog/service';

import { answerOutcome } from './recalculation';
const object = (value: unknown): Row => typeof value === 'object' && value !== null ? value as Row : {};
const selectionColumns = sql`${publicColumns},q.correct_key,q.explanation,q.distractor_notes,q.reviewer_name,q.reviewer_crm,q.reference_date,src.url source_url`;
export const sessionFilterSelectionSQL=(userId:string,query:QuestionListQuery,count:number)=>sql`WITH selected AS MATERIALIZED (SELECT q.id FROM question_bank q
  ${['favorite','doubtful'].includes(query.state??'')?sql`LEFT JOIN question_user_state us ON us.question_id=coalesce(q.canonical_id,q.id) AND us.user_id=${userId}`:sql``}
  WHERE ${catalogWhere(userId,query,true)} ORDER BY q.created_at DESC,q.id DESC LIMIT ${count})
  SELECT ${selectionColumns} FROM selected JOIN question_bank q ON q.id=selected.id ${catalogJoins(userId)} ORDER BY q.created_at DESC,q.id DESC`;
async function lockedSession(tx: Tx, userId: string, id: string): Promise<Row> {
  const [session] = await asServer<Row>(tx, sql`SELECT *,clock_timestamp() server_time FROM question_sessions WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
  if (!session) throw missing(); return session;
}
const items = (tx: Tx, userId: string, sessionId: string) => asServer<Row>(tx, sql`SELECT * FROM question_session_items WHERE session_id=${sessionId} AND user_id=${userId} ORDER BY position`);
/** Return the saved reference only after checking current access. Publication withdrawal never bypasses this gate. */
async function reference(tx: Tx, userId: string, item: Row): Promise<QuestionReferenceAfterAnswer> {
  const [current] = await asServer<Row>(tx, sql`SELECT q.id,q.availability,${obsoleteSuccessor} obsolete
    FROM question_bank q WHERE q.id=${item.question_id} AND ${readable(userId,true)}`);
  if (!current) throw missing();
  const saved = object(item.reference_snapshot);
  return questionReferenceAfterAnswerSchema.parse({ ...saved, annulled: saved.annulled === true || current.availability === 'annulled', obsolete: saved.obsolete === true || current.obsolete === true });
}
function snapshotReference(q: Row): QuestionReferenceAfterAnswer {
  return questionReferenceAfterAnswerSchema.parse({ questionId:q.id,version:q.version,correctKey:q.correct_key ?? null,explanation:q.explanation ?? null,distractorNotes:q.distractor_notes ?? null,
    annulled:q.availability==='annulled' || q.occurrence_annulled===true, reviewed:q.reviewed ?? false,reviewerName:q.reviewer_name ?? null,reviewerCrm:q.reviewer_crm ?? null,referenceDate:q.reference_date ?? null,sourceUrl:q.source_url ?? null,obsolete:false });
}
/** Fisher–Yates, server randomness; saved key mapping is never a public field. */
export function shuffleQuestion(question: QuestionPublic, ref: QuestionReferenceAfterAnswer) {
  if (!question.alternatives) return {question,reference:ref,map:{}};
  const alternatives=[...question.alternatives];
  for(let i=alternatives.length-1;i>0;i--){const j=randomInt(i+1);[alternatives[i],alternatives[j]]=[alternatives[j]!,alternatives[i]!];}
  const map:Record<string,string>={}; const notes:Record<string,string>={};
  const shuffled=alternatives.map((a,i)=>{const key=catalogAlternativeKeys[i]!;map[key]=a.key;if(ref.distractorNotes?.[a.key])notes[key]=ref.distractorNotes[a.key]!;return {key,text:a.text};});
  return {question:{...question,alternatives:shuffled},reference:{...ref,correctKey:Object.entries(map).find(([,original])=>original===ref.correctKey)?.[0] ?? null,distractorNotes:ref.distractorNotes?notes:null},map};
}
function frozenReport(session:Row, rows:Row[]):QuestionSessionReport {
  const counts={correct:0,incorrect:0,unanswered:0,annulled:0};
  const results=rows.map((item)=>{
    const ref=questionReferenceAfterAnswerSchema.parse(item.reference_snapshot);
    const result=answerOutcome(item.answered===true,item.selected_key==null?null:String(item.selected_key),ref.correctKey,ref.annulled);
    counts[result]++; return {itemId:String(item.id),result,reference:ref};
  });
  const denominator=counts.correct+counts.incorrect+counts.unanswered;
  return questionSessionReportSchema.parse({sessionId:session.id,version:1,...counts,denominator,score:denominator?counts.correct/denominator:null,items:results});
}
async function finalize(tx:Tx,userId:string,session:Row,expired=false):Promise<Row>{
  if(session.status!=='active')return session;
  const report=frozenReport(session,await items(tx,userId,String(session.id)));
  const [updated]=await asServer<Row>(tx,sql`UPDATE question_sessions SET status=${expired?'expired':'finished'},finished_at=clock_timestamp(),revision=revision+1,report=${JSON.stringify(report)}::jsonb,updated_at=now() WHERE id=${session.id} AND user_id=${userId} RETURNING *,clock_timestamp() server_time`);
  return updated!;
}
async function settle(tx:Tx,userId:string,session:Row){
  return session.status==='active' && session.deadline && new Date(String(session.server_time)).getTime()>=new Date(String(session.deadline)).getTime() ? finalize(tx,userId,session,true):session;
}
async function publicSession(tx:Tx,userId:string,session:Row){
  const rows=await items(tx,userId,String(session.id));
  const visibleRows=await asServer<Row>(tx,sql`SELECT q.id,b.id board_id,b.title board_title,ARRAY(SELECT c.id FROM cards c WHERE c.board_id=b.id AND c.deleted_at IS NULL AND c.id=ANY(q.card_ids)) card_ids,coalesce(us.favorite,false) favorite,coalesce(us.doubtful,false) doubtful,coalesce(us.annotation,'') annotation FROM question_bank q ${catalogJoins(userId)} WHERE q.id=ANY(${pgArray(rows.map(i=>String(i.question_id)),'uuid')}) AND ${readable(userId,true)}`);
  const visibleById=new Map(visibleRows.map(q=>[String(q.id),q]));
  const output=await Promise.all(rows.map(async(item)=>{
    // No references selected by the public DTO. Access is checked even for frozen private snapshots.
    const visible=visibleById.get(String(item.question_id));
    const payload=object(item.payload_public);
    // Build only the input here; the final strict session schema validates every nested question exactly once.
    const question=visible ? {...payload,boardId:visible.board_id??null,boardTitle:visible.board_title??null,cardIds:visible.card_ids??[],assets:await publicAssets(payload.assets),userState:{favorite:visible.favorite,doubtful:visible?.doubtful ?? false,annotation:visible.annotation}} : {...payload,stem:'Questão indisponível.',alternatives:null,assets:[],availability:'unavailable',reviewed:false,cardIds:[],boardId:null,boardTitle:null,sourceLabel:null,sourceId:null,occurrences:{items:[],total:0,truncated:false},topicId:null,areaId:null,userState:undefined};
    return {id:item.id,position:item.position,question,originalNumber:visible ? item.original_number ?? null : null,selectedKey:item.selected_key ?? null,answered:item.answered,doubtful:visible?.doubtful ?? false,revision:item.revision};
  }));
  return questionSessionPublicSchema.parse({id:session.id,mode:session.mode,status:session.status,revision:session.revision,startedAt:session.started_at,deadline:session.deadline ?? null,finishedAt:session.finished_at ?? null,serverTime:session.server_time,items:output});
}
async function gatedReport(tx:Tx,userId:string,session:Row){
  if(session.status==='active')throw conflict('session_not_finished');
  const report=questionSessionReportSchema.parse(session.report);
  const rows=await items(tx,userId,String(session.id));
  const visibleRows=await asServer<Row>(tx,sql`SELECT q.id,q.availability,${obsoleteSuccessor} obsolete FROM question_bank q WHERE q.id=ANY(${pgArray(rows.map(i=>String(i.question_id)),'uuid')}) AND ${readable(userId,true)}`);
  const visible=new Map(visibleRows.map(q=>[String(q.id),q]));
  const checked=new Map<string,QuestionReferenceAfterAnswer>();
  for(const item of rows){const current=visible.get(String(item.question_id));const saved=object(item.reference_snapshot);if(!current){checked.set(String(item.id),questionReferenceAfterAnswerSchema.parse({...saved,correctKey:null,explanation:null,distractorNotes:null,reviewed:false,reviewerName:null,reviewerCrm:null,referenceDate:null,sourceUrl:null,obsolete:true}));continue;}checked.set(String(item.id),questionReferenceAfterAnswerSchema.parse({...saved,annulled:saved.annulled===true||current.availability==='annulled',obsolete:saved.obsolete===true||current.obsolete===true}));}
  // Scores remain frozen. Current obsolescence/annulment warnings attach to each saved reference.
  return questionSessionReportSchema.parse({...report,items:report.items.map((i)=>({...i,reference:checked.get(i.itemId)!}))});
}
/** Shared batch finalization for bounded metadata pages; no snapshots leave this helper. */
export async function settleSessionSummaries(tx:Tx,userId:string,sessions:Row[]){
      const expired=sessions.filter(s=>s.status==='active' && s.deadline && new Date(String(s.server_time)).getTime()>=new Date(String(s.deadline)).getTime());
      if(expired.length){
        const saved=await asServer<Row>(tx,sql`SELECT id,session_id,reference_snapshot,selected_key,answered FROM question_session_items WHERE user_id=${userId} AND session_id=ANY(${pgArray(expired.map(s=>String(s.id)),'uuid')}) ORDER BY session_id,position`);
        const reports=expired.map(s=>({id:s.id,report:frozenReport(s,saved.filter(i=>i.session_id===s.id))}));
        const updated=await asServer<Row>(tx,sql`UPDATE question_sessions s SET status='expired',finished_at=clock_timestamp(),revision=s.revision+1,report=x.report,updated_at=now() FROM jsonb_to_recordset(${JSON.stringify(reports)}::jsonb) x(id uuid,report jsonb) WHERE s.id=x.id AND s.user_id=${userId} RETURNING s.id,s.status,s.revision,s.finished_at,clock_timestamp() server_time`);
        for(const row of sessions){const current=updated.find(u=>u.id===row.id);if(current)Object.assign(row,current);}
      }
}
export const questionSessionService={
  async create(userId:string,config:QuestionSessionConfig,key:string){
    const result=await run(userId,async(tx)=>{
      // Owner-scoped transaction lock serializes retry before selection; it does not lock any other user's request.
      await asServer(tx,sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId+':'+key},33))`);
      const [existing]=await asServer<Row>(tx,sql`SELECT *,clock_timestamp() server_time FROM question_sessions WHERE user_id=${userId} AND idempotency_key=${key} FOR UPDATE`);
      if(existing){if(JSON.stringify(existing.config)!==JSON.stringify(JSON.parse(JSON.stringify(config)))){
        // jsonb property order differs from input. Compare canonical jsonb, not JavaScript property order.
        const [same]=await asServer<Row>(tx,sql`SELECT config=${JSON.stringify(config)}::jsonb same FROM question_sessions WHERE id=${existing.id} AND user_id=${userId}`);
        if(!same?.same)throw conflict('idempotency_key_reused');
      }return publicSession(tx,userId,await settle(tx,userId,existing));}
      let rows:Row[];const timer=config.timerSec;
      if(config.examId){
        const [paper]=await asServer<Row>(tx,sql`SELECT p.duration_sec FROM exam_papers p JOIN question_sources src ON src.id=p.source_id WHERE p.id=${config.examId} AND ${paperAccess}`);if(!paper)throw missing();
        rows=await asServer<Row>(tx,sql`SELECT ${selectionColumns},o.original_keys,o.original_number,o.annulled occurrence_annulled FROM exam_question_occurrences o JOIN question_bank q ON q.id=o.question_id ${catalogJoins(userId)} WHERE o.paper_id=${config.examId} AND ${readable(userId)} AND q.type='objective' ORDER BY o.ordinal LIMIT ${config.count}`);
        const [count]=await asServer<Row>(tx,sql`SELECT count(*)::int n FROM exam_question_occurrences WHERE paper_id=${config.examId}`);
        if(Number(count?.n??0)!==config.count || rows.length!==config.count)throw conflict('exam_count_must_match_full_paper');
      }else if(config.questionIds){
        if(new Set(config.questionIds).size!==config.questionIds.length || config.questionIds.length!==config.count)throw validation('selection_count_mismatch');
        rows=await asServer<Row>(tx,sql`SELECT ${selectionColumns} FROM question_bank q ${catalogJoins(userId)} WHERE q.id=ANY(${pgArray(config.questionIds,'uuid')}) AND ${catalogWhere(userId,questionListQuerySchema.parse({}),true)} ORDER BY array_position(${pgArray(config.questionIds,'uuid')},q.id)`);
        if(rows.length!==config.questionIds.length)throw missing();
      }else{
        const query=config.filters!;if(query.cursor)throw validation('session_cursor_not_supported');
        rows=await withTiming('questions.select',()=>asServer<Row>(tx,sessionFilterSelectionSQL(userId,query,config.count)));
      }
      if(!config.examId && !config.questionIds && rows.length<config.count)throw validation('insufficient_questions:'+rows.length);
      rows=rows.map(applyOccurrence);
      if(!rows.length)throw validation('no_eligible_questions');
      const [session]=await asServer<Row>(tx,sql`INSERT INTO question_sessions(user_id,mode,paper_id,config,idempotency_key,deadline) VALUES(${userId},${config.mode},${config.examId??null},${JSON.stringify(config)}::jsonb,${key},CASE WHEN ${timer}::int IS NULL THEN NULL ELSE now()+make_interval(secs=>${timer}::int) END) RETURNING *,clock_timestamp() server_time`);
      const payloads=await withTiming('questions.snapshot',async()=>{const payloads=[];
      for(const [position,row]of rows.entries()){
        const publicQ=await toQuestion({...row,assets:[]});
        const ref=snapshotReference(row);const shuffled=config.shuffle?shuffleQuestion(publicQ,ref):{question:publicQ,reference:ref,map:{}};
        payloads.push({question_id:row.id,position,original_number:row.original_number??null,payload_public:{...shuffled.question,assets:row.assets??[]},reference_snapshot:shuffled.reference,shuffle_map:shuffled.map});
      }return payloads;});
      await withTiming('questions.freeze',()=>asServer(tx,sql`INSERT INTO question_session_items(user_id,session_id,question_id,position,original_number,payload_public,reference_snapshot,shuffle_map)
        SELECT ${userId}::uuid,${session!.id}::uuid,x.question_id,x.position,x.original_number,x.payload_public,x.reference_snapshot,x.shuffle_map FROM jsonb_to_recordset(${JSON.stringify(payloads)}::jsonb) AS x(question_id uuid,position int,original_number text,payload_public jsonb,reference_snapshot jsonb,shuffle_map jsonb)`));
      return withTiming('questions.public',()=>publicSession(tx,userId,session!));
    });return result;
  },
  async get(userId:string,id:string){return run(userId,async(tx)=>publicSession(tx,userId,await settle(tx,userId,await lockedSession(tx,userId,id))));},
  async list(userId:string){
    return run(userId,async(tx)=>{
      const sessions=await asServer<Row>(tx,sql`SELECT s.id,s.mode,s.status,s.revision,s.started_at,s.deadline,s.finished_at,clock_timestamp() server_time,
        counts.count,counts.answered_count FROM question_sessions s LEFT JOIN LATERAL
        (SELECT count(*)::int count,count(*) FILTER(WHERE i.answered)::int answered_count FROM question_session_items i WHERE i.session_id=s.id AND i.user_id=${userId}) counts ON true
        WHERE s.user_id=${userId} ORDER BY s.created_at DESC,s.id DESC LIMIT 20 FOR UPDATE OF s`);
      await settleSessionSummaries(tx,userId,sessions);
      return sessions.map(s=>questionSessionSummaryPublicSchema.parse({id:s.id,mode:s.mode,status:s.status,revision:s.revision,startedAt:s.started_at,deadline:s.deadline??null,finishedAt:s.finished_at??null,serverTime:s.server_time,count:s.count,answeredCount:s.answered_count}));
    });
  },
  async answer(userId:string,id:string,itemId:string,input:QuestionAnswerInput){
    const result=await run(userId,async(tx)=>{
      const session=await settle(tx,userId,await lockedSession(tx,userId,id));
      const [item]=await asServer<Row>(tx,sql`SELECT * FROM question_session_items WHERE id=${itemId} AND session_id=${id} AND user_id=${userId} FOR UPDATE`);if(!item)throw missing();
      const [prior]=await asServer<Row>(tx,sql`SELECT selected_key,revision,submitted_at FROM question_answers WHERE item_id=${itemId} AND session_id=${id} AND user_id=${userId} AND mutation_id=${input.mutationId}`);
      if(prior){if(prior.selected_key!==input.selectedKey)throw conflict('mutation_id_reused');return {saved:questionAnswerSavedSchema.parse({itemId,selectedKey:prior.selected_key,revision:prior.revision,savedAt:prior.submitted_at})};}
      if(session.status!=='active')return {closed:true as const};
      const [eligible]=await asServer<Row>(tx,sql`SELECT q.id FROM question_bank q WHERE q.id=${item.question_id} AND ${readable(userId)}`);if(!eligible)throw missing();
      await reference(tx,userId,item);
      if(item.revision!==input.revision)throw conflict('answer_revision_changed');
      if(session.mode==='study' && item.answered)throw conflict('study_answer_immutable');
      const question=object(item.payload_public);const alternatives=question.alternatives as {key:string}[];
      if(input.selectedKey!==null && !alternatives.some((a)=>a.key===input.selectedKey))throw validation('invalid_alternative');
      const ref=object(item.reference_snapshot);const correct=ref.annulled?null:input.selectedKey!==null&&input.selectedKey===ref.correctKey;
      const [answer]=await asServer<Row>(tx,sql`INSERT INTO question_answers(user_id,session_id,item_id,mutation_id,selected_key,correct,elapsed_ms,revision) VALUES(${userId},${id},${itemId},${input.mutationId},${input.selectedKey},${correct},${input.elapsedMs},${input.revision+1}) RETURNING submitted_at`);
      await asServer(tx,sql`UPDATE question_session_items SET selected_key=${input.selectedKey},answered=true,revision=revision+1,updated_at=now() WHERE id=${itemId} AND session_id=${id} AND user_id=${userId}`);
      await asServer(tx,sql`UPDATE question_sessions SET revision=revision+1,updated_at=now() WHERE id=${id} AND user_id=${userId}`);
      return {saved:questionAnswerSavedSchema.parse({itemId,selectedKey:input.selectedKey,revision:input.revision+1,savedAt:answer!.submitted_at})};
    });if('closed'in result)throw conflict('session_closed');await invalidate('question.changed',{userId});return result.saved;
  },
  async reference(userId:string,id:string,itemId:string){return run(userId,async(tx)=>{
    const session=await settle(tx,userId,await lockedSession(tx,userId,id));const [item]=await asServer<Row>(tx,sql`SELECT * FROM question_session_items WHERE id=${itemId} AND session_id=${id} AND user_id=${userId}`);if(!item)throw missing();
    if(session.mode==='simulation' && session.status==='active' || session.mode==='study' && !item.answered && session.status==='active')throw conflict('reference_not_available');return reference(tx,userId,item);
  });},
  async finish(userId:string,id:string){const result=await run(userId,async(tx)=>{const s=await settle(tx,userId,await lockedSession(tx,userId,id));return gatedReport(tx,userId,await finalize(tx,userId,s));});await invalidate('challenge.finished',{userId});return result;},
  async report(userId:string,id:string){return run(userId,async(tx)=>gatedReport(tx,userId,await settle(tx,userId,await lockedSession(tx,userId,id))));},
  async review(userId:string,id:string){const count=await run(userId,async(tx)=>{
    const session=await settle(tx,userId,await lockedSession(tx,userId,id));if(session.mode==='simulation'&&session.status==='active')throw conflict('session_not_finished');
    // This explicit command only advances existing schedules for the owner's linked cards. No attempt or automatic FSRS grade.
    const rows=await asServer<Row>(tx,sql`UPDATE fsrs_state f SET due=now(),updated_at=now() WHERE f.user_id=${userId} AND f.due>now() AND f.card_id IN (
      SELECT DISTINCT c.id FROM question_session_items i JOIN question_bank q ON q.id=i.question_id CROSS JOIN LATERAL unnest(q.card_ids) linked(card_id)
      JOIN cards c ON c.id=linked.card_id JOIN boards b ON b.id=c.board_id AND b.user_id=${userId}
      WHERE i.session_id=${id} AND i.user_id=${userId} AND q.user_id=${userId} AND q.visibility='private' AND ${readable(userId)} AND i.answered=true
      AND (i.selected_key IS NULL OR i.selected_key <> i.reference_snapshot->>'correctKey') AND coalesce((i.reference_snapshot->>'annulled')::boolean,false)=false AND c.deleted_at IS NULL AND c.suspended_at IS NULL AND b.archived_at IS NULL AND c.type<>'note'
      AND (CASE WHEN c.type IN ('flow','image') THEN EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->(CASE WHEN c.type='flow' THEN 'steps' ELSE 'masks' END))='array' THEN c.payload->(CASE WHEN c.type='flow' THEN 'steps' ELSE 'masks' END) ELSE '[]'::jsonb END) sub WHERE sub->>'id'=f.sub_id) ELSE f.sub_id='' END)) RETURNING f.card_id`);return new Set(rows.map(r=>String(r.card_id))).size;
  });if(count)await invalidate('review.answered',{userId});return {cards:count};},
};
