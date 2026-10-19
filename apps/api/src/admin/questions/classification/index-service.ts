/** Server-pinned automatic search suggestions; never a clinical review or a mutation of signed question content. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx} from '@remoa/db';
import {err,ok,QUESTION_CLASSIFICATION_RUN_ID,QUESTION_CLASSIFICATION_BUNDLE_HASH,QUESTION_CLASSIFICATION_EXPECTED_COUNT,QUESTION_CLASSIFICATION_NODE_COUNT} from '@remoa/contracts';
import type {AuditCapture} from '../../core';
import {idempotentReplay} from '../operations';
import seed from '../../../../../../packages/db/seed/question-classification/g29-v1.json';
const raw=Buffer.from(JSON.stringify(seed)+'\n');
if(createHash('sha256').update(raw).digest('hex')!==QUESTION_CLASSIFICATION_BUNDLE_HASH)throw Error('classification_bundle_hash_mismatch');
if(seed.runId!==QUESTION_CLASSIFICATION_RUN_ID||seed.nodes.length!==QUESTION_CLASSIFICATION_NODE_COUNT||seed.bindings.length!==QUESTION_CLASSIFICATION_EXPECTED_COUNT)throw Error('classification_bundle_count_mismatch');
type Row=Record<string,unknown>;
export async function indexAutomaticClassification(tx:Tx,actor:string,input:{idempotencyKey:string;reason:string},audit:AuditCapture){
 await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${seed.namespace},34))`);
 const [prior]=await tx.execute<Row>(sql`SELECT * FROM question_classification_runs WHERE id=${seed.runId} FOR UPDATE`);
 if(prior&&(prior.status!=='active'||prior.bundle_hash!==QUESTION_CLASSIFICATION_BUNDLE_HASH||prior.withdrawn_at))return err('conflict','classification_run_changed');
 const requestHash=QUESTION_CLASSIFICATION_BUNDLE_HASH;
 const replay=await idempotentReplay(tx,'question.import',actor,input.idempotencyKey,requestHash);if(!replay.ok)return replay;
 audit.before({run:prior??null});
 if(!prior){
 await tx.execute(sql`INSERT INTO question_classification_runs(id,namespace,queue_hash,rule_hash,rule_version,bundle_hash,corpus_hash,membership_hash,expected_count,expected_nodes,actor_id) VALUES(${seed.runId},${seed.namespace},${seed.queueHash},${seed.ruleHash},${seed.ruleVersion},${QUESTION_CLASSIFICATION_BUNDLE_HASH},${seed.corpusHash},${seed.membershipHash},${seed.expectedCount},${seed.nodes.length},${actor})`);
 for(const kind of ['area','topic']){
  const nodes=seed.nodes.filter(n=>n.kind===kind);
  await tx.execute(sql`INSERT INTO question_classification_nodes(id,run_id,course_code,kind,parent_id,code,label) SELECT (x->>'id')::uuid,${seed.runId}::uuid,x->>'courseCode',x->>'kind',(x->>'parentId')::uuid,x->>'code',x->>'label' FROM jsonb_array_elements(${JSON.stringify(nodes)}::jsonb)x`);
 }
 await tx.execute(sql`INSERT INTO question_classification_bindings(run_id,question_id,content_hash,payload_hash,course_code,area_id,topic_id,evidence) SELECT ${seed.runId}::uuid,(x->>'questionId')::uuid,x->>'contentHash',x->>'payloadHash',x->>'courseCode',(x->>'areaId')::uuid,(x->>'topicId')::uuid,x->'evidence' FROM jsonb_array_elements(${JSON.stringify(seed.bindings)}::jsonb)x`);
 await tx.execute(sql`UPDATE question_classification_runs SET status='active',activated_at=now() WHERE id=${seed.runId} AND status='draft'`);
 await tx.execute(sql`ANALYZE question_classification_runs,question_classification_nodes,question_classification_bindings`);
 }
 // Replays verify every pinned row; neither another idempotency key nor a retry reenters publication triggers.
 const [check]=await tx.execute<{nodes:number;bindings:number;usable:number}>(sql`SELECT
 (SELECT count(*)::int FROM jsonb_array_elements(${JSON.stringify(seed.nodes)}::jsonb)x JOIN question_classification_nodes n ON n.id=(x->>'id')::uuid WHERE n.run_id=${seed.runId} AND n.course_code=x->>'courseCode' AND n.kind=x->>'kind' AND n.parent_id IS NOT DISTINCT FROM (x->>'parentId')::uuid AND n.code=x->>'code' AND n.label=x->>'label') nodes,
 (SELECT count(*)::int FROM jsonb_array_elements(${JSON.stringify(seed.bindings)}::jsonb)x JOIN question_classification_bindings b ON b.run_id=${seed.runId} AND b.question_id=(x->>'questionId')::uuid WHERE b.content_hash=x->>'contentHash' AND b.payload_hash=x->>'payloadHash' AND b.course_code=x->>'courseCode' AND b.area_id=(x->>'areaId')::uuid AND b.topic_id=(x->>'topicId')::uuid AND b.evidence=x->'evidence') bindings,
 (SELECT count(*)::int FROM question_classification_bindings b JOIN question_bank q ON q.id=b.question_id WHERE b.run_id=${seed.runId} AND q.content_hash=b.content_hash AND q.reviewed_hash=b.content_hash AND q.profession_code=b.course_code AND public.f33_team_question_visible(q.id,q.content_hash)) usable`);
 if(check?.nodes!==QUESTION_CLASSIFICATION_NODE_COUNT||check.bindings!==QUESTION_CLASSIFICATION_EXPECTED_COUNT||check.usable!==QUESTION_CLASSIFICATION_EXPECTED_COUNT)throw Error('classification_index_readback_failed');
 audit.after({idempotencyKey:input.idempotencyKey,requestHash,runId:seed.runId,queueHash:seed.queueHash,ruleHash:seed.ruleHash,bundleHash:QUESTION_CLASSIFICATION_BUNDLE_HASH,classificationKind:'automatic_unreviewed',humanReviewed:false,...check,results:[],...(replay.data?{replayOf:replay.data.auditId}:{})});
 return ok({replayed:!!replay.data,runId:seed.runId,nodes:check.nodes,bindings:check.bindings,classificationKind:'automatic_unreviewed' as const,humanReviewed:false as const});
}
