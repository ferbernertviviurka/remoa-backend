import { invalidate } from '../../cache';
import { createHash,randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ReceiptPersistenceError,completionFromEnvelope,parseJsonText,withCompletionReceipts,type HttpCompletionEnvelope,type Completion,type CompletionReceiptCall,type CompletionReceiptHooks } from '@remoa/ai';
import { idSchema, questionBankServerSchema, type QuestionBankServer } from '@remoa/contracts';
import { asServer,run } from '../../db';
import { putBytes,getBytes,headObject } from '../../storage/storage';
export const RECEIPT_MAX_BYTES=16*1024*1024;
export const RECEIPT_MAX_CANDIDATES=1000;
type ObjectRow=Record<string,unknown>;
export type ReceiptMeta={ownerId:string;producer:'challenge_objective'|'challenge_discursive'|'map_extract'|'summary_checklist';requestKey:string;promptId:string;promptVersion:string;boardId:string|null;boardVersion:number|null;context?:unknown};
export type ReceiptRecord={version:1|2;runId:string;meta:ReceiptMeta;call:CompletionReceiptCall;completion:Completion;envelope?:HttpCompletionEnvelope};
export type CandidateReceipt={value:unknown;stem:string|null;reason:string|null;diagnostic?:boolean};
const object=(v:unknown):ObjectRow=>v && typeof v==='object' && !Array.isArray(v)?v as ObjectRow:{};
export const receiptHash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
/** A malformed reply is one quarantined receipt; its full original text remains in the private object. */
export function receiptCandidates(text:string,producer:ReceiptMeta['producer']):CandidateReceipt[]{
  let parsed:ObjectRow;try{parsed=object(parseJsonText(text));}catch{return[{value:{raw:text},stem:null,reason:'invalid_json',diagnostic:true}];}
  let list:unknown[]=[];
  if(producer==='challenge_objective')list=Array.isArray(parsed.questoes)?parsed.questoes:[];
  if(producer==='challenge_discursive')list=Array.isArray(parsed.perguntas)?parsed.perguntas:[];
  if(producer==='map_extract')list=Array.isArray(parsed.cards)?parsed.cards:[];
  if(producer==='summary_checklist')list=(Array.isArray(parsed.secoes)?parsed.secoes:[]).flatMap(s=>{const sec=object(s);return String(sec.tipo).toLowerCase().trim()==='checklist' && Array.isArray(sec.itens)?sec.itens:[];});
  if(!list.length)return[{value:parsed,stem:null,reason:'no_candidates_or_unknown_shape',diagnostic:true}];
  return list.map(value=>{const v=object(value);const text=v.enunciado??v.question??v.texto;return{value,stem:typeof text==='string'?text:null,reason:producer==='map_extract' || producer==='summary_checklist'?'reference_requires_review':null};});
}
/** Diagnostic sentinels conserve evidence but are not generated questions. */
export const receivedQuestionCount=(candidates:readonly CandidateReceipt[])=>candidates.filter(candidate=>!candidate.diagnostic).length;
/** Decode only after caller verifies durable object ownership, metadata and SHA. */
export function decodeReceiptRecord(record:ReceiptRecord):ReceiptRecord {
 if(record.version===1){if(typeof record.completion?.text!=='string')throw new ReceiptPersistenceError('receipt_version_invalid');return record;}
 if(record.version!==2 || !record.envelope)throw new ReceiptPersistenceError('receipt_version_invalid');
 return{...record,completion:completionFromEnvelope(record.envelope)};
}
export function receiptEvidence(record:ReceiptRecord):{record:ReceiptRecord;candidates:CandidateReceipt[];quarantine:string|null}{
 try{const decoded=decodeReceiptRecord(record),candidates=receiptCandidates(decoded.completion.text,decoded.meta.producer);return{record:decoded,candidates,quarantine:candidates.length>RECEIPT_MAX_CANDIDATES?'candidate_limit_quarantine':null};}
 catch{if(record.version!==2 || !record.envelope)throw new ReceiptPersistenceError('receipt_version_invalid');return{record:{...record,completion:{text:'',model:typeof record.envelope.model==='string'&&/^[a-zA-Z0-9/_.:@+-]{1,200}$/.test(record.envelope.model)?record.envelope.model:'unknown',tokensIn:0,tokensOut:0,latencyMs:record.envelope.latencyMs,attempts:record.envelope.attempts,fallback:record.envelope.fallback,billable:true}},candidates:[{value:{envelope:true,bodyComplete:record.envelope.bodyComplete},stem:null,reason:(['body_limit','body_read_failed'].includes(record.envelope.errorCode??'')?record.envelope.errorCode!:'invalid_http_envelope'),diagnostic:true}],quarantine:(['body_limit','body_read_failed'].includes(record.envelope.errorCode??'')?record.envelope.errorCode!:'invalid_http_envelope')};}
}
export function validateReceiptPreflight(meta:ReceiptMeta,call:CompletionReceiptCall){
 if(!idSchema.safeParse(meta.ownerId).success || !['challenge_objective','challenge_discursive','map_extract','summary_checklist'].includes(meta.producer) || typeof meta.requestKey!=='string'||meta.requestKey.length>2000 || typeof meta.promptId!=='string'||meta.promptId.length>256 || typeof meta.promptVersion!=='string'||meta.promptVersion.length>256 || meta.boardId!==null&&!idSchema.safeParse(meta.boardId).success || meta.boardVersion!==null&&(!Number.isSafeInteger(meta.boardVersion)||meta.boardVersion<1) || !['generate','extract','summary'].includes(call.fn)||!Number.isSafeInteger(call.index)||call.index<0 || typeof call.repaired!=='boolean')throw new ReceiptPersistenceError('receipt_metadata_invalid');
 let bytes:number;try{bytes=Buffer.byteLength(JSON.stringify(meta),'utf8');}catch{throw new ReceiptPersistenceError('receipt_metadata_invalid');}
 if(bytes>4*1024*1024 || Buffer.byteLength(JSON.stringify(call),'utf8')>4096)throw new ReceiptPersistenceError('receipt_metadata_limit');
}
export interface ReceiptObjects{put(key:string,bytes:Buffer):Promise<void>;get(key:string,options?:{maxBytes?:number}):Promise<Buffer>;exists(key:string):Promise<boolean>}
const objects:ReceiptObjects={put:async(key,bytes)=>{await putBytes(key,bytes,'application/json');},get:getBytes,exists:async key=>Boolean(await headObject(key))};
export type ReservedReceipt={id:string;objectKey:string;replay:Completion|null;created?:boolean;hash?:string};
export interface ReceiptStore{
  reserve(meta:ReceiptMeta,call:CompletionReceiptCall):Promise<ReservedReceipt>;
  commit(record:ReceiptRecord,key:string,hash:string,candidates:CandidateReceipt[],quarantine:string|null,fence?:{outboxId:string;workerId:string}):Promise<void>;
  promote(ownerId:string,runIds:string[],rows:readonly QuestionBankServer[],fence?:{outboxId:string;workerId:string}):Promise<void>;
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const keyFor=(meta:ReceiptMeta,id:string)=>`questions/generation/${meta.ownerId}/${id}/receipt.json`;
/** Inventory includes uncertain reservations; only verified durable receipts participate in a promotion. */
export async function loadReceivedRecords(owner:string,runIds:readonly string[],storage:ReceiptObjects,loadMembers=(user:string,ids:readonly string[])=>run(user,tx=>asServer<ObjectRow>(tx,sql`SELECT id,producer,request_key,prompt_id,prompt_version,status,payload_object_key,payload_hash FROM question_generation_runs WHERE user_id=${user} AND id=ANY(ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}])`))){
  if(!runIds.length)return{runIds:[] as string[],records:[] as ReceiptRecord[]};
  if(runIds.length>1000 || new Set(runIds).size!==runIds.length || runIds.some(id=>!idSchema.safeParse(id).success))throw new ReceiptPersistenceError('promotion_owner_or_limit');
  const members=await loadMembers(owner,runIds);
  if(members.length!==runIds.length || new Set(members.map(row=>row.id)).size!==runIds.length || members.some(row=>!runIds.includes(String(row.id))))throw new ReceiptPersistenceError('receipt_owner_missing');
  const records:ReceiptRecord[]=[];
  for(const id of runIds){const member=members.find(row=>row.id===id)!;
    if(!['received','completed'].includes(String(member.status)))continue;
    if(typeof member.payload_hash!=='string' || !/^[a-f0-9]{64}$/.test(member.payload_hash) || member.payload_object_key!==`questions/generation/${owner}/${id}/receipt.json`)throw new ReceiptPersistenceError('receipt_hash_invalid');
    const bytes=await storage.get(String(member.payload_object_key));if(receiptHash(bytes)!==member.payload_hash)throw new ReceiptPersistenceError('receipt_hash_invalid');
    const record=JSON.parse(bytes.toString()) as ReceiptRecord;
    if(![1,2].includes(record.version) || record.runId!==id || record.meta?.ownerId!==owner || record.meta.producer!==member.producer || record.meta.promptId!==member.prompt_id || record.meta.promptVersion!==member.prompt_version || !record.call || `${record.meta.requestKey}:${record.call.index}:${Number(record.call.repaired)}`!==member.request_key || (record.version===1?typeof record.completion?.text!=='string':!record.envelope))throw new ReceiptPersistenceError('receipt_metadata_invalid');
    records.push(decodeReceiptRecord(record));
  }
  return{runIds:records.map(record=>record.runId),records};
}

export const receiptStore:ReceiptStore={
  async reserve(meta,call){return run(meta.ownerId,async(tx)=>{
    const key=meta.requestKey+':'+call.index+':'+Number(call.repaired);
    const jobId=object(meta.context).jobId;
    if(jobId!==undefined && !idSchema.safeParse(jobId).success)throw new ReceiptPersistenceError('receipt_invalid_job');
    await asServer(tx,sql`SELECT pg_advisory_xact_lock(hashtextextended(${meta.ownerId+':'+meta.producer+':'+(typeof jobId==='string'?'map-job:'+jobId:key)},33))`);
    if(meta.producer==='map_extract' && typeof jobId==='string'){
      const [uncertain]=await asServer<ObjectRow>(tx,sql`SELECT id FROM question_generation_runs WHERE user_id=${meta.ownerId} AND producer='map_extract' AND request_key LIKE ${'map-job:'+jobId+':%'} AND status='reserved' AND request_key<>${key} LIMIT 1`);
      if(uncertain)throw new ReceiptPersistenceError('previous_attempt_uncertain');
    }
    const [existing]=await asServer<ObjectRow>(tx,sql`SELECT id,payload_object_key,payload_hash,status FROM question_generation_runs WHERE user_id=${meta.ownerId} AND producer=${meta.producer} AND request_key=${key} FOR UPDATE`);
    if(existing){
      const objectKey=String(existing.payload_object_key);if(existing.status==='quarantined')throw new ReceiptPersistenceError('receipt_quarantined');if(existing.status==='reserved')throw new ReceiptPersistenceError('receipt_pending_reconciliation');
      // Reading the object outside this small transaction happens in the hooks load below.
      return{id:String(existing.id),objectKey,replay:null,hash:String(existing.payload_hash)};
    }
    const id=randomUUID(),objectKey=keyFor(meta,id);
    await asServer(tx,sql`INSERT INTO question_generation_runs(id,user_id,producer,request_key,prompt_id,prompt_version,board_id,board_version,model,provider,payload_object_key,status) VALUES(${id},${meta.ownerId},${meta.producer},${key},${meta.promptId},${meta.promptVersion},${meta.boardId},${meta.boardVersion},'pending','pending',${objectKey},'reserved')`);
    // Written before the external call: a crash after object PUT can be reconciled without another provider request.
    await asServer(tx,sql`INSERT INTO question_outbox(run_id,event_key,target,payload_reference) VALUES(${id},${'question-receipt:'+id},'question-receipt',${objectKey})`);
    return{id,objectKey,replay:null,created:true} as ReservedReceipt &{created:boolean};
  });},
  async commit(record,key,hash,candidates,quarantine,fence){await run(record.meta.ownerId,async(tx)=>{
    const [row]=await asServer<ObjectRow>(tx,sql`SELECT id,payload_hash FROM question_generation_runs WHERE id=${record.runId} AND user_id=${record.meta.ownerId} FOR UPDATE`);if(!row)throw new ReceiptPersistenceError('receipt_owner_missing');
    if(row.payload_hash && row.payload_hash!==hash)throw new ReceiptPersistenceError('receipt_hash_changed');
    if(fence){const [owned]=await asServer<ObjectRow>(tx,sql`SELECT id FROM question_outbox WHERE id=${fence.outboxId} AND run_id=${record.runId} AND worker_id=${fence.workerId} AND lease_until>now() AND delivered_at IS NULL FOR UPDATE`);if(!owned)throw new ReceiptPersistenceError('receipt_lease_lost');}
    await asServer(tx,sql`UPDATE question_generation_runs SET model=${record.completion.model},provider='openrouter',payload_hash=${hash},received_count=${receivedQuestionCount(candidates)},status=${quarantine?'quarantined':'received'},error_code=${quarantine},updated_at=now() WHERE id=${record.runId} AND user_id=${record.meta.ownerId}`);
    const accepted=quarantine?[{ordinal:0,state:'needs_review',reason:quarantine}]:candidates.map((c,ordinal)=>({ordinal,state:c.reason?'needs_review':'pending',reason:c.reason}));
    await asServer(tx,sql`INSERT INTO question_generation_candidates(run_id,ordinal,payload_object_key,state,reason_code) SELECT ${record.runId}::uuid,x.ordinal,${key},x.state,x.reason FROM jsonb_to_recordset(${JSON.stringify(accepted)}::jsonb) x(ordinal int,state text,reason text) ON CONFLICT(run_id,ordinal) DO NOTHING`);
    await asServer(tx,fence?sql`UPDATE question_outbox SET delivered_at=now(),worker_id=NULL,lease_until=NULL,error_code=NULL WHERE id=${fence.outboxId} AND worker_id=${fence.workerId}`:sql`UPDATE question_outbox SET delivered_at=now(),worker_id=NULL,lease_until=NULL,error_code=NULL WHERE run_id=${record.runId} AND target='question-receipt'`);
  });},
  async promote(ownerId,runIds,rows,fence){
    if(runIds.length>1000 || rows.length>1000 || new Set(runIds).size!==runIds.length || runIds.some(id=>!idSchema.safeParse(id).success) || rows.some(row=>row.userId!==ownerId))throw new ReceiptPersistenceError('promotion_owner_or_limit');
    const {records}=await loadReceivedRecords(ownerId,runIds,objects);
    if(records.length!==runIds.length)throw new ReceiptPersistenceError('promotion_receipts_not_ready');
    // Reuse the producer's existing schemas and screening guards; a repaired reply must
    // never promote a malformed original merely because both contain the same stem.
    const {objectiveReplySchema,discursiveReplySchema,screenReply}=await import('../../challenge-ai/generate');
    const available=new Map<string,{runId:string;ordinal:number;expected:string;explanation:string|null;options:string[];evidence:string}[]>();
    for(const rec of [...records].reverse())for(const [ordinal,c]of receiptCandidates(rec.completion.text,rec.meta.producer).entries()){
      const context=object(rec.meta.context);const refs=Array.isArray(context.refs)?new Map(context.refs as [string,import('../../challenge-ai/generate').ScopeCard][]):new Map<string,import('../../challenge-ai/generate').ScopeCard>();
      const type=rec.meta.producer==='challenge_objective'?'objective':'discursive';
      const parsed=type==='objective'?objectiveReplySchema.safeParse({questoes:[c.value]}):discursiveReplySchema.safeParse({perguntas:[c.value]});
      if(!parsed.success)continue;
      const items='questoes' in parsed.data?parsed.data.questoes:parsed.data.perguntas;
      const candidate=screenReply(type,items,refs,[]).kept[0];if(!candidate)continue;
      const q=candidate.question;
      const evidence=JSON.stringify(q.evidencias.map(e=>[e.card,e.trecho]).sort());
      available.set(q.enunciado,[...(available.get(q.enunciado)??[]),{runId:rec.runId,ordinal,expected:q.resposta_esperada,explanation:q.explicacao||null,options:(q.alternativas??[]).map(a=>a.texto).sort(),evidence}]);
    }
    await run(ownerId,async(tx,s)=>{
      if(fence){
        await asServer(tx,sql`SELECT id FROM question_generation_runs WHERE user_id=${ownerId} AND id=ANY(ARRAY[${sql.join(runIds.map(id=>sql`${id}::uuid`),sql`, `)}]) ORDER BY id FOR UPDATE`);
        const [owned]=await asServer<ObjectRow>(tx,sql`SELECT id FROM question_outbox WHERE id=${fence.outboxId} AND worker_id=${fence.workerId} AND lease_until>now() AND delivered_at IS NULL FOR UPDATE`);
        if(!owned)throw new ReceiptPersistenceError('promotion_lease_lost');
      }
      const linked=new Set<string>();
      for(const row of rows){const candidates=available.get(row.stem)??[];const match=candidates.findIndex(c=>c.expected===row.expectedAnswer && c.explanation===row.explanation && JSON.stringify(c.options)===JSON.stringify((row.alternatives??[]).map(a=>a.text).sort()) && c.evidence===JSON.stringify(row.evidences.map(e=>[e.cardId,e.excerpt]).sort()));const receipt=match<0?undefined:candidates.splice(match,1)[0];if(!receipt)throw new ReceiptPersistenceError('candidate_without_receipt');
        const [candidate]=await asServer<ObjectRow>(tx,sql`SELECT c.id,c.question_id FROM question_generation_candidates c JOIN question_generation_runs r ON r.id=c.run_id WHERE c.run_id=${receipt.runId} AND c.ordinal=${receipt.ordinal} AND r.user_id=${ownerId} FOR UPDATE`);if(!candidate)throw new ReceiptPersistenceError('candidate_missing');
        if(!candidate.question_id){const [own]=await asServer<ObjectRow>(tx,sql`SELECT id FROM boards WHERE id=${row.boardId} AND user_id=${ownerId}`);if(!own)throw new ReceiptPersistenceError('board_owner_missing');
          const provenance=records.find(rec=>rec.runId===receipt.runId)!;
          await asServer(tx,tx.insert(s.questionBank).values({...row,id:String(candidate.id),userId:ownerId,origin:'ai_generated',visibility:'private',model:provenance.completion.model,promptId:provenance.meta.promptId,promptVersion:provenance.meta.promptVersion}).onConflictDoNothing().getSQL());
          await asServer(tx,sql`UPDATE question_generation_candidates SET state='accepted',reason_code=NULL,question_id=${candidate.id},updated_at=now() WHERE id=${candidate.id}`);
        }
        // The caller uses the receipt's stable question id on replay, rather than generating a second identity.
        (row as QuestionBankServer).id=String(candidate.question_id??candidate.id);linked.add(receipt.runId+':'+receipt.ordinal);
      }
      for(const rec of records){const candidates=receiptCandidates(rec.completion.text,rec.meta.producer);for(const [ordinal,c]of candidates.entries())if(!linked.has(rec.runId+':'+ordinal))await asServer(tx,sql`UPDATE question_generation_candidates SET state=CASE WHEN state IN ('accepted','rejected','duplicate') THEN state ELSE 'needs_review' END,reason_code=CASE WHEN state IN ('accepted','rejected','duplicate') THEN reason_code ELSE ${c.reason??'screened_out_or_unselected'} END,updated_at=now() WHERE run_id=${rec.runId} AND ordinal=${ordinal}`);
        await asServer(tx,sql`UPDATE question_generation_runs SET status='completed',updated_at=now() WHERE id=${rec.runId} AND user_id=${ownerId}`);
      }
    });
    const maps=new Set(rows.map(row=>row.boardId).filter((id):id is string=>typeof id==='string'));
    if(!maps.size && rows.length)await invalidate('question.changed',{userId:ownerId});
    for(const mapId of maps)await invalidate('question.changed',{userId:ownerId,mapId});
  },
};
export type PromotionReservation = { reference:string; delivered:boolean };
export interface PromotionPort {
  load(owner:string,runId:string):Promise<PromotionReservation|null>;
  reserve(owner:string,runIds:readonly string[],reference:string,fence?:{outboxId:string;workerId:string}):Promise<PromotionReservation>;
  delivered(owner:string,runId:string,reference:string):Promise<void>;
}
export const promotionStore:PromotionPort={
  async load(owner,runId){return run(owner,async tx=>{const [entry]=await asServer<ObjectRow>(tx,sql`SELECT o.payload_reference,o.delivered_at FROM question_outbox o JOIN question_generation_runs r ON r.id=o.run_id WHERE r.id=${runId} AND r.user_id=${owner} AND o.event_key=${'question-promotion:'+runId}`);return entry?{reference:String(entry.payload_reference),delivered:entry.delivered_at!==null}:null;});},
  async reserve(owner,runIds,reference,fence){return run(owner,async tx=>{
    if(!runIds.length || runIds.length>1000 || new Set(runIds).size!==runIds.length || runIds.some(id=>!idSchema.safeParse(id).success))throw new ReceiptPersistenceError('promotion_owner_or_limit');
    const entries=await asServer<ObjectRow>(tx,sql`SELECT id,payload_hash FROM question_generation_runs WHERE user_id=${owner} AND id=ANY(ARRAY[${sql.join(runIds.map(id=>sql`${id}::uuid`),sql`, `)}]) ORDER BY id FOR UPDATE`);
    if(entries.length!==runIds.length || entries.some(r=>!r.payload_hash))throw new ReceiptPersistenceError('promotion_receipts_not_ready');
    if(fence){const [owned]=await asServer<ObjectRow>(tx,sql`SELECT id FROM question_outbox WHERE id=${fence.outboxId} AND run_id=${runIds[0]} AND worker_id=${fence.workerId} AND lease_until>now() AND delivered_at IS NULL FOR UPDATE`);if(!owned)throw new ReceiptPersistenceError('promotion_discovery_lease_lost');}
    const id=runIds[0]!;await asServer(tx,sql`INSERT INTO question_outbox(run_id,event_key,target,payload_reference) VALUES(${id},${'question-promotion:'+id},'question-promotion',${reference}) ON CONFLICT(event_key) DO NOTHING`);
    const [saved]=await asServer<ObjectRow>(tx,sql`SELECT payload_reference,delivered_at FROM question_outbox WHERE run_id=${id} AND event_key=${'question-promotion:'+id} FOR UPDATE`);
    if(!saved || saved.payload_reference!==reference)throw new ReceiptPersistenceError('promotion_plan_changed');
    return{reference:String(saved.payload_reference),delivered:saved.delivered_at!==null};
  });},
  async delivered(owner,runId,reference){await run(owner,tx=>asServer(tx,sql`UPDATE question_outbox o SET delivered_at=now(),worker_id=NULL,lease_until=NULL,error_code=NULL FROM question_generation_runs r WHERE r.id=o.run_id AND r.user_id=${owner} AND r.id=${runId} AND o.event_key=${'question-promotion:'+runId} AND o.payload_reference=${reference} AND o.worker_id IS NULL`));},
};
const promotionContent=(rows:readonly QuestionBankServer[])=>JSON.stringify(canonical(rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='id'&&key!=='createdAt')))));
const promotionReference=(owner:string,runId:string,reference:string)=>{
  const [key,hash,...rest]=reference.split('#');
  if(rest.length || !key?.startsWith(`questions/generation/${owner}/${runId}/`) || key.split('/').some(p=>p==='..'||p==='.'||p==='') || !hash || !/^[a-f0-9]{64}$/.test(hash))throw new ReceiptPersistenceError('promotion_reference_invalid');
  return{key,hash};
};
/** Replay accepts only identical content; ephemeral caller identity/time never overwrite a durable plan. */
export async function savePromotion(owner:string,runIds:readonly string[],rows:readonly QuestionBankServer[],storage:ReceiptObjects,port:PromotionPort,promote:ReceiptStore['promote']){
  if(!runIds.length || runIds.length>1000 || new Set(runIds).size!==runIds.length || runIds.some(id=>!idSchema.safeParse(id).success) || rows.length>1000 || rows.some(r=>r.userId!==owner))throw new ReceiptPersistenceError('promotion_owner_or_limit');
  rows.forEach(row=>questionBankServerSchema.parse(row));
  const runId=runIds[0]!;
  let saved=await port.load(owner,runId);
  let bytes:Buffer;
  if(saved){
    const ref=promotionReference(owner,runId,saved.reference);bytes=await storage.get(ref.key,{maxBytes:RECEIPT_MAX_BYTES});
    if(receiptHash(bytes)!==ref.hash)throw new ReceiptPersistenceError('promotion_hash_invalid');
    const raw=JSON.parse(bytes.toString()) as {ownerId:string;runIds:string[];rows:unknown[]};
    if(raw.ownerId!==owner || JSON.stringify(raw.runIds)!==JSON.stringify(runIds) || !Array.isArray(raw.rows))throw new ReceiptPersistenceError('promotion_owner_or_limit');
    const original=raw.rows.map(row=>questionBankServerSchema.parse(row));
    if(promotionContent(original)!==promotionContent(rows))throw new ReceiptPersistenceError('promotion_plan_changed');
    rows.forEach((row,index)=>Object.assign(row,original[index]));
  }else{
    bytes=Buffer.from(JSON.stringify({ownerId:owner,runIds,rows}));
    if(bytes.length>RECEIPT_MAX_BYTES)throw new ReceiptPersistenceError('promotion_size_limit');
    const hash=receiptHash(bytes),key=`questions/generation/${owner}/${runId}/promotion-${hash}.json`;
    // Durable reservation precedes external I/O. Equal concurrent plans can only PUT equal bytes.
    saved=await port.reserve(owner,runIds,key+'#'+hash);
    const ref=promotionReference(owner,runId,saved.reference);
    if(saved.reference!==key+'#'+hash)throw new ReceiptPersistenceError('promotion_plan_changed');
    if(await storage.exists(ref.key)){
      if(receiptHash(await storage.get(ref.key,{maxBytes:RECEIPT_MAX_BYTES}))!==hash)throw new ReceiptPersistenceError('promotion_hash_invalid');
    }else await storage.put(ref.key,bytes);
  }
  await promote(owner,[...runIds],rows);
  await port.delivered(owner,runId,saved.reference);
}

export class GenerationReceipts{
  readonly runs:string[]=[];
  constructor(readonly meta:ReceiptMeta,readonly store:ReceiptStore=receiptStore,readonly storage:ReceiptObjects=objects){}
  hooks():CompletionReceiptHooks{
    const reserved=new Map<number,ReservedReceipt>();const enveloped=new Set<number>();
    return{
      load:async call=>{try{validateReceiptPreflight(this.meta,call);const r=await this.store.reserve(this.meta,call);if(!idSchema.safeParse(r.id).success || r.objectKey!==keyFor(this.meta,r.id))throw new ReceiptPersistenceError('receipt_owner_mismatch');reserved.set(call.index,r);if(!this.runs.includes(r.id))this.runs.push(r.id);
        if(!r.created) {if(typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))throw new ReceiptPersistenceError('receipt_hash_invalid');const raw=await this.storage.get(r.objectKey,{maxBytes:RECEIPT_MAX_BYTES});if(receiptHash(raw)!==r.hash)throw new ReceiptPersistenceError('receipt_hash_invalid');const record=JSON.parse(raw.toString()) as ReceiptRecord;if(record.meta.ownerId!==this.meta.ownerId || record.runId!==r.id || record.meta.producer!==this.meta.producer || record.meta.requestKey!==this.meta.requestKey || JSON.stringify(canonical(record.meta))!==JSON.stringify(canonical(this.meta)) || JSON.stringify(canonical(record.call))!==JSON.stringify(canonical(call)))throw Error('receipt_owner_mismatch');return decodeReceiptRecord(record).completion;}return null;
      }catch(e){throw e instanceof ReceiptPersistenceError?e:new ReceiptPersistenceError('receipt_load_failed');}},
      failed:async(call,failure)=>{
        if(this.store!==receiptStore)return;const r=reserved.get(call.index);if(!r)return;
        await run(this.meta.ownerId,async tx=>{
          await asServer(tx,sql`UPDATE question_generation_runs SET status=${failure.knownNoCompletion?'provider_failed':'reserved'},error_code=${failure.code},updated_at=now() WHERE id=${r.id} AND user_id=${this.meta.ownerId} AND payload_hash IS NULL AND status='reserved'`);
          if(failure.knownNoCompletion)await asServer(tx,sql`UPDATE question_outbox SET delivered_at=now(),error_code=${failure.code},lease_until=NULL,worker_id=NULL WHERE run_id=${r.id} AND target='question-receipt' AND delivered_at IS NULL`);
        });
      },
      saveEnvelope:async(call,envelope)=>{
        if(enveloped.has(call.index))throw new ReceiptPersistenceError('receipt_envelope_already_saved');
        const r=reserved.get(call.index);if(!r)throw new ReceiptPersistenceError('receipt_not_reserved');
        const record:ReceiptRecord={version:2,runId:r.id,meta:this.meta,call,envelope,completion:{text:'',model:envelope.model,tokensIn:0,tokensOut:0,latencyMs:envelope.latencyMs,attempts:envelope.attempts,fallback:envelope.fallback,billable:true}};
        const bytes=Buffer.from(JSON.stringify({version:2,runId:record.runId,meta:record.meta,call:record.call,envelope}));if(bytes.length>RECEIPT_MAX_BYTES)throw new ReceiptPersistenceError('receipt_size_quarantine');
        try{await this.storage.put(r.objectKey,bytes);const evidence=receiptEvidence(record);await this.store.commit(evidence.record,r.objectKey,receiptHash(bytes),evidence.candidates,evidence.quarantine);enveloped.add(call.index);}catch{throw new ReceiptPersistenceError('receipt_save_failed');}
      },
      save:async(call,completion)=>{if(enveloped.has(call.index))return;const r=reserved.get(call.index);if(!r)throw new ReceiptPersistenceError('receipt_not_reserved');const record:ReceiptRecord={version:1,runId:r.id,meta:this.meta,call,completion};const bytes=Buffer.from(JSON.stringify(record));const candidates=receiptCandidates(completion.text,this.meta.producer);
        const quarantine=bytes.length>RECEIPT_MAX_BYTES?'receipt_size_quarantine':candidates.length>RECEIPT_MAX_CANDIDATES?'candidate_limit_quarantine':null;
        try{await this.storage.put(r.objectKey,bytes);await this.store.commit(record,r.objectKey,receiptHash(bytes),candidates,quarantine);if(quarantine)throw new ReceiptPersistenceError(quarantine);}catch{throw new ReceiptPersistenceError('receipt_save_failed');}
      },
    };
  }
  wrap<T>(fn:()=>Promise<T>){return withCompletionReceipts(this.hooks(),fn);}
  async attachMap(boardId:string,boardVersion:number){
    const {records}=await loadReceivedRecords(this.meta.ownerId,this.runs,this.storage);
    await run(this.meta.ownerId,async(tx,s)=>{
      const [board]=await asServer<ObjectRow>(tx,sql`SELECT id,version FROM boards WHERE id=${boardId} AND user_id=${this.meta.ownerId}`);if(!board || Number(board.version)<boardVersion)throw new ReceiptPersistenceError('board_version_changed');
      const cards=await asServer<ObjectRow>(tx,sql`SELECT id,front,back,source_excerpt FROM cards WHERE board_id=${boardId} AND deleted_at IS NULL`);
      for(const record of records){await asServer(tx,sql`UPDATE question_generation_runs SET board_id=${boardId},board_version=${boardVersion},updated_at=now() WHERE id=${record.runId} AND user_id=${this.meta.ownerId}`);
        for(const [ordinal,candidate]of receiptCandidates(record.completion.text,'map_extract').entries()){
          const value=object(candidate.value);const card=cards.find(c=>typeof value.question==='string' && typeof value.answer==='string' && c.front===value.question.trim() && c.back===value.answer.trim() && typeof value.sourceExcerpt==='string' && c.source_excerpt===value.sourceExcerpt.trim());
          if(!card){await asServer(tx,sql`UPDATE question_generation_candidates SET state=CASE WHEN state='accepted' THEN state ELSE 'needs_review' END,reason_code=CASE WHEN state='accepted' THEN reason_code ELSE 'extracted_card_filtered_or_unresolved' END WHERE run_id=${record.runId} AND ordinal=${ordinal}`);continue;}
          const [entry]=await asServer<ObjectRow>(tx,sql`SELECT id,question_id FROM question_generation_candidates WHERE run_id=${record.runId} AND ordinal=${ordinal} FOR UPDATE`);if(!entry || entry.question_id)continue;
          const [duplicate]=await asServer<ObjectRow>(tx,sql`SELECT id FROM question_bank WHERE user_id=${this.meta.ownerId} AND board_id=${boardId} AND visibility='private' AND origin='ai_generated' AND stem=${card.front} AND expected_answer=${card.back} ORDER BY created_at LIMIT 1`);
          if(duplicate){await asServer(tx,sql`UPDATE question_generation_candidates SET state='duplicate',reason_code='duplicate_private_question',question_id=${duplicate.id} WHERE id=${entry.id}`);continue;}
          await asServer(tx,tx.insert(s.questionBank).values({id:String(entry.id),userId:this.meta.ownerId,boardId,boardVersion,cardIds:[String(card.id)],type:'discursive',difficulty:'medium',stem:String(card.front),alternatives:null,correctKey:null,expectedAnswer:String(card.back),keyPoints:[],explanation:null,evidences:[{cardId:String(card.id),excerpt:String(card.source_excerpt).slice(0,600)}],source:'ai',origin:'ai_generated',visibility:'private',promptId:record.meta.promptId,promptVersion:record.meta.promptVersion,model:record.completion.model,status:'draft'}).onConflictDoNothing().getSQL());
          await asServer(tx,sql`UPDATE question_generation_candidates SET state='accepted',reason_code=NULL,question_id=${entry.id},updated_at=now() WHERE id=${entry.id}`);
        }
      }
    });
    await invalidate('question.changed',{userId:this.meta.ownerId,mapId:boardId});
  }
  async markScreened(decisions:ReadonlyMap<string,{state:'rejected'|'duplicate';reason:string}>){
    if(this.store!==receiptStore)return;
    const {records}=await loadReceivedRecords(this.meta.ownerId,this.runs,this.storage);
    for(const record of records){const id=record.runId;
      await run(this.meta.ownerId,async tx=>{for(const [ordinal,candidate]of receiptCandidates(record.completion.text,this.meta.producer).entries()){const decision=candidate.stem?decisions.get(candidate.stem):null;if(decision)await asServer(tx,sql`UPDATE question_generation_candidates SET state=${decision.state},reason_code=${decision.reason},updated_at=now() WHERE run_id=${id} AND ordinal=${ordinal} AND state<>'accepted'`);}});
    }
  }
  async saveRows(rows:readonly QuestionBankServer[]){
    if(this.runs.length && this.store===receiptStore){
      const received=await loadReceivedRecords(this.meta.ownerId,this.runs,this.storage);
      if(!received.runIds.length){if(rows.length)throw new ReceiptPersistenceError('promotion_receipts_not_ready');return;}
      await savePromotion(this.meta.ownerId,received.runIds,rows,this.storage,promotionStore,this.store.promote.bind(this.store));
    }else await this.store.promote(this.meta.ownerId,this.runs,rows);
  }
}
export const createGenerationReceipts=(meta:ReceiptMeta)=>new GenerationReceipts(meta);
