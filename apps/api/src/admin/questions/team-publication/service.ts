import { sql } from 'drizzle-orm';
import { pgArray } from '../../../db';
import { teamReadable } from '../../../questions/catalog/service';
import type { Tx } from '@remoa/db';
import { err, ok, type QuestionTeamAssetsInput, type QuestionTeamItemsInput } from '@remoa/contracts';
import { headObject, getBytes, putBytes } from '../../../storage/storage';
import { idempotentReplay } from '../operations';
import type { AuditCapture } from '../../core';
import { ATTESTATION,CORPUS_HASH,MANIFEST_HASH,MEMBERSHIP_HASH,NAMESPACE,decodeFiles,files,fixedId,hash,objectKey,parseBatch,project } from './domain';
type Row=Record<string,unknown>;
const batchId=fixedId('batch');
const verified=new Set<string>();
async function batch(tx:Tx,actor:string,activeAllowed=false){
 const [b]=await tx.execute<Row>(sql`SELECT * FROM question_team_batches WHERE id=${batchId} FOR UPDATE`);
 if(!b||b.actor_id!==actor||b.revoked_at||(!activeAllowed&&b.sealed_at))throw Error('team_batch_not_writable');return b;
}
async function assetExists(path:string,forceReadback=false){
 const pin=files.get(path);if(!pin)throw Error('team_asset_not_pinned');const key=objectKey(pin.sha256),h=await headObject(key);
 if(!h||h.size!==pin.bytes)throw Error('team_asset_unavailable');
 if(forceReadback||!verified.has(pin.sha256)){const body=await getBytes(key,{maxBytes:pin.bytes});if(hash(body)!==pin.sha256)throw Error('team_asset_corrupt');verified.add(pin.sha256);}
}
export async function createBatch(tx:Tx,actor:string,audit:AuditCapture){
 await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${NAMESPACE},29))`);
 const [prior]=await tx.execute<Row>(sql`SELECT * FROM question_team_batches WHERE namespace=${NAMESPACE} FOR UPDATE`);
 if(prior){if(prior.actor_id!==actor||prior.corpus_hash!==CORPUS_HASH||prior.manifest_hash!==MANIFEST_HASH||prior.membership_hash!==MEMBERSHIP_HASH||prior.revoked_at)return err('conflict','team_batch_metadata_changed');audit.after({namespace:NAMESPACE,batchId,replayed:true});return ok({batchId,replayed:true});}
 await tx.execute(sql`INSERT INTO question_team_batches(id,namespace,corpus_hash,manifest_hash,membership_hash,expected_count,attestation,actor_id) VALUES(${batchId},${NAMESPACE},${CORPUS_HASH},${MANIFEST_HASH},${MEMBERSHIP_HASH},28188,${ATTESTATION},${actor})`);
 audit.after({namespace:NAMESPACE,batchId,corpusHash:CORPUS_HASH,manifestHash:MANIFEST_HASH,membershipHash:MEMBERSHIP_HASH,count:28188,attestation:ATTESTATION});return ok({batchId,replayed:false});
}
/** All storage keys and bytes are pinned server-side; retry verifies existing bytes instead of overwriting them. */
export async function uploadAssets(tx:Tx,actor:string,input:QuestionTeamAssetsInput,audit:AuditCapture){
 await batch(tx,actor,true);const prepared=decodeFiles(input.files),requestHash=hash(JSON.stringify(prepared.map(f=>[f.path,f.sha256])));
 const replay=await idempotentReplay(tx,'question.team_assets_upload',actor,input.idempotencyKey,requestHash);if(!replay.ok)return replay;
 for(const f of prepared){const h=await headObject(f.key);if(h){if(h.size!==f.bytes||hash(await getBytes(f.key,{maxBytes:f.bytes}))!==f.sha256)throw Error('team_asset_corrupt');}else{await putBytes(f.key,f.body,f.mime);if(hash(await getBytes(f.key,{maxBytes:f.bytes}))!==f.sha256)throw Error('team_asset_write_failed');}verified.add(f.sha256);}
 const results=prepared.map(f=>({path:f.path,sha256:f.sha256,bytes:f.bytes}));audit.after({idempotencyKey:input.idempotencyKey,requestHash,results,...(replay.data?{replayOf:replay.data.auditId}:{})});return ok({replayed:!!replay.data,results});
}
export async function importItems(tx:Tx,actor:string,input:QuestionTeamItemsInput,audit:AuditCapture){
 const rows=parseBatch(input.batchIndex,input.rawJsonl),projected=rows.map(project),requestHash=hash(input.rawJsonl);
 await batch(tx,actor,true);
 const replay=await idempotentReplay(tx,'question.team_items_import',actor,input.idempotencyKey,requestHash);if(!replay.ok)return replay;
 if(replay.data){audit.after({idempotencyKey:input.idempotencyKey,requestHash,replayOf:replay.data.auditId,count:rows.length});return ok({replayed:true,results:replay.data.results});}
 const [b]=await tx.execute<Row>(sql`SELECT sealed_at FROM question_team_batches WHERE id=${batchId}`);if(b?.sealed_at)return err('conflict','team_batch_sealed');
 const prior=await tx.execute<Row>(sql`SELECT offline_id,payload_hash,source_line_hash,content_hash,scope_hash,question_id FROM question_team_items WHERE batch_id=${batchId} AND offline_id=ANY(${pgArray(rows.map(r=>r.offlineId),'text')})`);
 if(prior.length){if(prior.length!==rows.length||prior.some(x=>{const i=rows.findIndex(r=>r.offlineId===x.offline_id),p=projected[i]!,r=rows[i]!;return x.payload_hash!==r.payloadSha256||x.source_line_hash!==r.sourceLineSha256||x.content_hash!==p.contentHash||x.scope_hash!==p.scopeHash||x.question_id!==p.questionId;}))return err('conflict','team_partial_or_changed_batch');const results=projected.map(p=>({id:p.questionId,outcome:'published'}));audit.after({idempotencyKey:input.idempotencyKey,requestHash,results,reconciled:true});return ok({replayed:true,results});}
 for(const path of new Set(projected.flatMap(p=>p.paths)))await assetExists(path);
 const data=projected.map((p,i)=>({...p,payload:rows[i]!.payload,offlineId:rows[i]!.offlineId,payloadHash:rows[i]!.payloadSha256,sourceLineHash:rows[i]!.sourceLineSha256}));
 const json=JSON.stringify(data);
 await tx.execute(sql`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_scope) SELECT DISTINCT ON(x->>'sourceId') (x->>'sourceId')::uuid,x->>'sourceName',x->>'sourcePublisher',coalesce(x->>'sourceUrl',''),'pending',${NAMESPACE} FROM jsonb_array_elements(${json}::jsonb)x ON CONFLICT(id) DO NOTHING`);
 const blocked=await tx.execute<Row>(sql`SELECT id FROM question_sources WHERE id IN(SELECT (x->>'sourceId')::uuid FROM jsonb_array_elements(${json}::jsonb)x) AND (rights_status<>'pending' OR rights_scope IS DISTINCT FROM ${NAMESPACE} OR rights_expires_at IS NOT NULL) LIMIT 1`);if(blocked.length)return err('conflict','team_source_changed');
 await tx.execute(sql`INSERT INTO question_bank(id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,origin,visibility,catalog_status,rights_status,availability,source_id,content_hash,assets,profession_code)
 SELECT (x->>'questionId')::uuid,'objective',x->>'difficulty',x->>'stem',x->'alternatives',x->>'correctKey','','student','official_exam','public','in_review','pending',x->>'availability',(x->>'sourceId')::uuid,x->>'contentHash',x->'assets',x->>'profession' FROM jsonb_array_elements(${json}::jsonb)x`);
 await tx.execute(sql`INSERT INTO question_team_items(id,batch_id,offline_id,question_id,payload_hash,source_line_hash,content_hash,scope_hash,source_id,profession_code,flags,original_payload)
 SELECT (x->>'itemId')::uuid,${batchId},x->>'offlineId',(x->>'questionId')::uuid,x->>'payloadHash',x->>'sourceLineHash',x->>'contentHash',x->>'scopeHash',(x->>'sourceId')::uuid,x->>'profession',ARRAY(SELECT jsonb_array_elements_text(x->'flags')),x->'payload' FROM jsonb_array_elements(${json}::jsonb)x`);
 await tx.execute(sql`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,kind,content_hash,decision,reason,reference_date,team_scope_hash)
 SELECT (x->>'questionId')::uuid,${actor},'Remoa',NULL,'remoa_team_attested',x->>'contentHash','approved',${ATTESTATION},'2026-10-19',x->>'scopeHash' FROM jsonb_array_elements(${json}::jsonb)x`);
 await tx.execute(sql`UPDATE question_bank q SET status='approved',catalog_status='published',reviewed_hash=q.content_hash,reviewer_name='Remoa',reviewer_crm=NULL,validation_kind='remoa_team_attested',reference_date='2026-10-19',published_at=now() WHERE q.id IN(SELECT (x->>'questionId')::uuid FROM jsonb_array_elements(${json}::jsonb)x)`);
 const results=projected.map(p=>({id:p.questionId,outcome:'published'}));audit.after({idempotencyKey:input.idempotencyKey,requestHash,batchIndex:input.batchIndex,results,count:rows.length,attestation:ATTESTATION});return ok({replayed:false,results});
}
const assetProofMarker=Symbol('verified-frozen-assets');
export type AssetProof={readonly [assetProofMarker]:true;readonly startedAt:number;readonly finishedAt:number;readonly inventoryHash:string;readonly count:number};
/** Authenticated route calls this before opening the short activation transaction. */
export async function verifyActivationAssets():Promise<AssetProof>{
 const startedAt=Date.now(),queue=[...files.keys()];let next=0,failure:unknown;
 await Promise.all(Array.from({length:6},async()=>{while(!failure&&next<queue.length){const index=next++;try{await assetExists(queue[index]!,true);}catch(error){failure=error;}}}));
 if(failure)throw Error('team_asset_verification_failed');
 if(Date.now()-startedAt>5*60_000)throw Error('team_asset_verification_expired');
 return Object.freeze({[assetProofMarker]:true as const,startedAt,finishedAt:Date.now(),inventoryHash:hash(JSON.stringify([...files.values()])),count:files.size});
}
export async function activateBatch(tx:Tx,actor:string,audit:AuditCapture,proof?:AssetProof){
 const b=await batch(tx,actor,true);if(b.activated_at){audit.after({namespace:NAMESPACE,replayed:true,count:28188});return ok({replayed:true,count:28188});}
 const rows=await tx.execute<Row>(sql`SELECT i.offline_id,i.payload_hash FROM question_team_items i JOIN question_bank q ON q.id=i.question_id WHERE i.batch_id=${batchId} AND q.catalog_status='published' AND q.content_hash=i.content_hash AND q.reviewed_hash=i.content_hash ORDER BY i.offline_id COLLATE "C"`);
 const membership=hash(rows.map(r=>`${String(r.offline_id)}\t${String(r.payload_hash)}\n`).join(''));if(rows.length!==28188||membership!==MEMBERSHIP_HASH)return err('conflict','team_membership_incomplete');
 // A server-created, bounded-age byte verification; never supplied by the HTTP caller.
 if(!proof||proof[assetProofMarker]!==true||proof.count!==files.size||proof.inventoryHash!==hash(JSON.stringify([...files.values()]))||Date.now()-proof.startedAt>5*60_000)throw Error('team_asset_verification_required');
 await tx.execute(sql`UPDATE question_team_batches SET sealed_at=now(),activated_at=now() WHERE id=${batchId} AND activated_at IS NULL AND revoked_at IS NULL`);
 const [visible]=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM question_team_items i JOIN question_bank q ON q.id=i.question_id WHERE i.batch_id=${batchId} AND public.f33_team_question_visible(q.id,q.content_hash)`);
 if(visible?.n!==28188)throw Error('team_activation_readback_failed');
 audit.after({namespace:NAMESPACE,count:28188,membershipHash:membership,assetsVerified:{count:proof.count,inventoryHash:proof.inventoryHash,startedAt:new Date(proof.startedAt).toISOString(),finishedAt:new Date(proof.finishedAt).toISOString()},attestation:ATTESTATION});return ok({replayed:false,count:28188});
}
export async function batchStatus(tx:Tx,audit:AuditCapture){
 const [row]=await tx.execute<Row>(sql`SELECT b.id,b.namespace,b.expected_count,b.activated_at,b.revoked_at,count(i.id)::int imported FROM question_team_batches b LEFT JOIN question_team_items i ON i.batch_id=b.id WHERE b.namespace=${NAMESPACE} GROUP BY b.id`);audit.after({namespace:NAMESPACE,imported:row?.imported??0});return ok({batch:row??null});
}

export const SOURCE_APPROVAL={rightsStatus:'authorized',rightsEvidence:'Aprovado por Remoa',rightsScope:NAMESPACE,rightsExpiresAt:'2030-11-19T23:59:59.000Z'} as const;
/** Only the immutable complete G29 batch's sources; source labels, acquisition URLs and every question signature remain unchanged. */
export async function approveBatchSources(tx:Tx,actor:string,input:{idempotencyKey:string;reason:string},audit:AuditCapture){
 if(input.reason!==SOURCE_APPROVAL.rightsEvidence)return err('validation','team_source_approval_reason_mismatch');
 const b=await batch(tx,actor,true);if(!b.activated_at)return err('conflict','team_batch_not_active');
 const members=await tx.execute<Row>(sql`SELECT offline_id,payload_hash FROM question_team_items WHERE batch_id=${batchId} ORDER BY offline_id COLLATE "C"`);
 if(members.length!==28188||hash(members.map(r=>`${String(r.offline_id)}\t${String(r.payload_hash)}\n`).join(''))!==MEMBERSHIP_HASH)return err('conflict','team_membership_incomplete');
 const sources=await tx.execute<Row>(sql`SELECT * FROM question_sources WHERE id IN(SELECT source_id FROM question_team_items WHERE batch_id=${batchId}) ORDER BY id FOR UPDATE`);
 if(sources.length!==841)return err('conflict','team_source_count_changed');
 const requestHash=hash(JSON.stringify({namespace:NAMESPACE,sources:sources.map(s=>s.id),approval:SOURCE_APPROVAL}));
 const replay=await idempotentReplay(tx,'question.source_update',actor,input.idempotencyKey,requestHash);if(!replay.ok)return replay;
 const approved=(s:Row)=>s.rights_status==='authorized'&&s.rights_scope===NAMESPACE&&s.rights_evidence===SOURCE_APPROVAL.rightsEvidence&&s.rights_expires_at!==null&&new Date(String(s.rights_expires_at)).toISOString()===SOURCE_APPROVAL.rightsExpiresAt;
 if(replay.data){if(!sources.every(approved))return err('conflict','team_source_approval_replay_state_changed');audit.after({idempotencyKey:input.idempotencyKey,requestHash,replayOf:replay.data.auditId,count:841,approval:SOURCE_APPROVAL});return ok({replayed:true,count:841,approval:SOURCE_APPROVAL});}
 if(sources.some(s=>s.rights_status!=='pending'&&!approved(s)))return err('conflict','team_source_state_changed');
 audit.before({sources});
 await tx.execute(sql`UPDATE question_sources SET rights_status='authorized',rights_evidence=${SOURCE_APPROVAL.rightsEvidence},rights_scope=${NAMESPACE},rights_expires_at=${SOURCE_APPROVAL.rightsExpiresAt}::timestamptz,updated_at=now() WHERE id IN(SELECT source_id FROM question_team_items WHERE batch_id=${batchId})`);
 const [visible]=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM question_bank q JOIN question_team_items i ON i.question_id=q.id WHERE i.batch_id=${batchId} AND ${teamReadable}`);
 if(visible?.n!==28188)throw Error('team_source_approval_visibility_failed');
 const results=sources.map(s=>({id:s.id,outcome:'approved'}));audit.after({idempotencyKey:input.idempotencyKey,requestHash,count:841,approval:SOURCE_APPROVAL,results});
 return ok({replayed:false,count:841,approval:SOURCE_APPROVAL});
}
