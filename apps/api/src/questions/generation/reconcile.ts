import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { questionBankServerSchema } from '@remoa/contracts';
import { dbm } from '../../db';
import { getBytes,headObject } from '../../storage/storage';
import { GenerationReceipts,receiptEvidence,receiptStore,receiptHash,RECEIPT_MAX_BYTES,type ReceiptRecord,promotionStore } from './receipts';
type Row=Record<string,unknown>;
/** Durable bounded worker. No provider call, no quota reservation, no public publication. */
export async function reconcileQuestionGenerations(limit=20){
  const {db}=await dbm();const worker=randomUUID();
  const jobs=await db.transaction(async tx=>tx.execute<Row>(sql`WITH pending AS (SELECT id FROM question_outbox WHERE target IN ('question-receipt','question-promotion') AND delivered_at IS NULL AND attempts<20 AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT ${Math.min(50,Math.max(1,limit))} FOR UPDATE SKIP LOCKED), claimed AS (UPDATE question_outbox o SET worker_id=${worker},lease_until=now()+interval '2 minutes',attempts=attempts+1 FROM pending p WHERE o.id=p.id RETURNING o.*) SELECT claimed.*,r.user_id owner_id FROM claimed JOIN question_generation_runs r ON r.id=claimed.run_id`));
  let delivered=0,failed=0;
  // Rotate legacy discovery durably; a negative HEAD is a cooldown, never a permanent exclusion.
  const discovery=await db.transaction(async tx=>{
    await tx.execute(sql`INSERT INTO question_outbox(run_id,event_key,target,payload_reference) SELECT r.id,'question-promotion-scan:'||r.id::text,'question-promotion-discovery','questions/generation/'||r.user_id::text||'/'||r.id::text||'/promotion.json' FROM question_generation_runs r WHERE r.producer IN ('challenge_objective','challenge_discursive') AND r.status IN ('received','completed') AND r.payload_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM question_outbox o WHERE o.event_key IN ('question-promotion:'||r.id::text,'question-promotion-scan:'||r.id::text)) ORDER BY r.created_at,r.id LIMIT ${Math.min(50,Math.max(1,limit))} ON CONFLICT(event_key) DO NOTHING`);
    return tx.execute<Row>(sql`WITH eligible AS(SELECT o.id FROM question_outbox o WHERE o.target='question-promotion-discovery' AND o.delivered_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now()) AND NOT EXISTS(SELECT 1 FROM question_outbox p WHERE p.event_key='question-promotion:'||o.run_id::text) ORDER BY o.updated_at,o.id LIMIT ${Math.min(50,Math.max(1,limit))} FOR UPDATE SKIP LOCKED), claimed AS(UPDATE question_outbox o SET worker_id=${worker},lease_until=now()+interval '2 minutes',attempts=attempts+1 FROM eligible e WHERE o.id=e.id RETURNING o.*) SELECT c.*,r.user_id owner_id FROM claimed c JOIN question_generation_runs r ON r.id=c.run_id`);
  });
  let discovered=0,discoveryFailed=0;
  for(const entry of discovery){try{
    const found=await discoverLegacyPromotion(String(entry.owner_id),String(entry.run_id),{exists:async key=>Boolean(await headObject(key)),get:async key=>getBytes(key,{maxBytes:RECEIPT_MAX_BYTES})},promotionStore,{outboxId:String(entry.id),workerId:worker});
    const ack=await db.execute<Row>(sql`UPDATE question_outbox SET delivered_at=CASE WHEN ${found} THEN now() ELSE NULL END,lease_until=CASE WHEN ${found} THEN NULL ELSE now()+interval '5 minutes' END,worker_id=NULL,error_code=NULL,updated_at=now() WHERE id=${entry.id} AND worker_id=${worker} AND lease_until>now() RETURNING id`);
    if(found && ack.length)discovered++;
  }catch{discoveryFailed++;await db.execute(sql`UPDATE question_outbox SET lease_until=now()+interval '5 minutes',worker_id=NULL,error_code='promotion_discovery_failed',updated_at=now() WHERE id=${entry.id} AND worker_id=${worker} AND lease_until>now()`);}}
  // A map may have committed immediately before the process died, before linking its receipts.
  const maps=await db.execute<Row>(sql`SELECT r.id,r.payload_object_key,j.board_id FROM question_generation_runs r JOIN ai_jobs j ON j.user_id=r.user_id AND r.request_key LIKE 'map-job:'||j.id::text||':%' WHERE r.producer='map_extract' AND r.board_id IS NULL AND r.status IN ('received','completed') AND j.board_id IS NOT NULL LIMIT ${Math.min(20,limit)}`);
  for(const map of maps){try{const raw=await getBytes(String(map.payload_object_key));const record=JSON.parse(raw.toString()) as ReceiptRecord;const receipts=new GenerationReceipts(record.meta);receipts.runs.push(String(map.id));await receipts.attachMap(String(map.board_id),1);delivered++;}catch{failed++;}}
  for(const job of jobs){
    try{
      const [key='',expectedHash]=String(job.payload_reference).split('#'),owner=String(job.owner_id);if(!key.startsWith(`questions/generation/${owner}/`))throw Error('receipt_owner_mismatch');
      if(!await headObject(key))throw Error('provider_receipt_missing');
      const bytes=await getBytes(key,{maxBytes:RECEIPT_MAX_BYTES});if(expectedHash && receiptHash(bytes)!==expectedHash)throw Error('promotion_hash_invalid');
      if(job.target==='question-receipt'){
        const record=JSON.parse(bytes.toString()) as ReceiptRecord;if(![1,2].includes(record.version) || record.meta.ownerId!==owner || record.runId!==job.run_id || (record.version===1?typeof record.completion?.text!=='string':!record.envelope))throw Error('invalid_receipt');
        const [saved]=await db.execute<Row>(sql`SELECT payload_hash FROM question_generation_runs WHERE id=${record.runId} AND user_id=${owner}`);if(!saved || saved.payload_hash && saved.payload_hash!==receiptHash(bytes))throw Error('receipt_hash_invalid');
        const evidence=receiptEvidence(record),candidates=evidence.candidates;await receiptStore.commit(evidence.record,key,receiptHash(bytes),candidates,bytes.length>RECEIPT_MAX_BYTES?'receipt_size_quarantine':evidence.quarantine,{outboxId:String(job.id),workerId:worker});
        // Object PUT may have succeeded immediately before a crash interrupted the promotion outbox insert.
        const promotion=key.replace('receipt.json','promotion.json');if(await headObject(promotion))await registerLegacyPromotion(owner,String(job.run_id),promotion,await getBytes(promotion,{maxBytes:RECEIPT_MAX_BYTES}),promotionStore);
      }else{
        const plan=JSON.parse(bytes.toString()) as {ownerId:string;runIds:string[];rows:unknown[]};if(plan.ownerId!==owner || !Array.isArray(plan.runIds) || !Array.isArray(plan.rows) || plan.rows.length>1000)throw Error('invalid_promotion');
        const rows=plan.rows.map(r=>questionBankServerSchema.parse(r));if(rows.some(r=>r.userId!==owner))throw Error('promotion_owner_mismatch');await receiptStore.promote(owner,plan.runIds,rows,{outboxId:String(job.id),workerId:worker});
        const ack=await db.execute<Row>(sql`UPDATE question_outbox SET delivered_at=now(),worker_id=NULL,lease_until=NULL,error_code=NULL WHERE id=${job.id} AND worker_id=${worker} AND lease_until>now() RETURNING id`);
        if(!ack.length)throw Error('promotion_lease_lost');
      }
      delivered++;
    }catch(error){failed++;const code=error instanceof Error && /^[a-z_]{3,100}$/.test(error.message)?error.message:error instanceof Error?error.name:'reconcile_failed';await db.execute(sql`UPDATE question_outbox SET lease_until=now()+interval '1 minute',worker_id=NULL,error_code=${code.slice(0,100)} WHERE id=${job.id} AND worker_id=${worker} AND lease_until>now()`);}
  }
  return{claimed:jobs.length,delivered,failed,discoveryClaimed:discovery.length,discovered,discoveryFailed};
}

/** Strict legacy artifact validation, independent of receipt delivery status. No object write or provider call. */
export async function registerLegacyPromotion(owner:string,runId:string,key:string,bytes:Buffer,port:import('./receipts').PromotionPort,fence?:{outboxId:string;workerId:string}){
  if(key!==`questions/generation/${owner}/${runId}/promotion.json` || bytes.length>RECEIPT_MAX_BYTES)throw Error('invalid_promotion');
  const plan=JSON.parse(bytes.toString()) as {ownerId:string;runIds:string[];rows:unknown[]};
  if(plan.ownerId!==owner || !Array.isArray(plan.runIds) || plan.runIds[0]!==runId || !Array.isArray(plan.rows) || plan.rows.length>1000)throw Error('invalid_promotion');
  const rows=plan.rows.map(row=>questionBankServerSchema.parse(row));
  if(rows.some(row=>row.userId!==owner))throw Error('promotion_owner_mismatch');
  return port.reserve(owner,plan.runIds,key+'#'+receiptHash(bytes),fence);
}

export async function discoverLegacyPromotion(owner:string,runId:string,storage:{exists(key:string):Promise<boolean>;get(key:string):Promise<Buffer>},port:import('./receipts').PromotionPort,fence?:{outboxId:string;workerId:string}){
  const key=`questions/generation/${owner}/${runId}/promotion.json`;
  if(!await storage.exists(key))return false;
  await registerLegacyPromotion(owner,runId,key,await storage.get(key),port,fence);
  return true;
}
