import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,expect,it,vi } from 'vitest';
import type { db as Database } from '@remoa/db';
import {captureHttpEnvelope,type Completion} from '@remoa/ai';
import type { QuestionBankServer } from '@remoa/contracts';
const cacheInvalidations=vi.hoisted(()=>vi.fn(async()=>{}));
vi.mock('../../cache',()=>({invalidate:cacheInvalidations}));
const objects=vi.hoisted(()=>new Map<string,Buffer>());
vi.mock('../../storage/storage',()=>({putBytes:async(key:string,value:Buffer)=>{objects.set(key,value);},getBytes:async(key:string)=>{const value=objects.get(key);if(!value)throw Error('not found');return value;},headObject:async(key:string)=>objects.has(key)?{size:objects.get(key)!.length}:null}));
import { GenerationReceipts,receiptStore,receiptHash,type ReceiptMeta,type ReceiptStore } from './receipts';
import { reconcileQuestionGenerations } from './reconcile';
const url=process.env.DATABASE_URL;
if(url){const target=new URL(url);if(!['127.0.0.1','localhost'].includes(target.hostname)||!['/remoa_f33_test_20261008','/f33_test'].includes(target.pathname))throw Error('isolated local f33_test required');}
describe.skipIf(!url)('durable generation receipts',()=>{
 let db:typeof Database.$client;const owner=randomUUID(),other=randomUUID(),board=randomUUID(),card=randomUUID();
 const meta=(requestKey:string=randomUUID()):ReceiptMeta=>({ownerId:owner,producer:'challenge_objective',requestKey,promptId:'synthetic',promptVersion:'test',boardId:board,boardVersion:1,context:{refs:[['c1',{id:card,type:'concept',title:'Synthetic evidence',front:'Synthetic evidence 0 1 2 3 4 5 6 7 8 9',back:'Synthetic evidence',payload:null,didactics:null}]]}});
 const completion=(count=10):Completion=>({text:JSON.stringify({questoes:Array.from({length:count},(_,i)=>({enunciado:'Synthetic question '+i,dificuldade:'medio',cards:['c1'],evidencias:[{card:'c1',trecho:'Synthetic evidence'}],alternativas:{A:'Synthetic A',B:'Synthetic B',C:'Synthetic C',D:'Synthetic D'},correta:'A',explicacao_correta:'Synthetic explanation'}))}),model:'test/model',tokensIn:1,tokensOut:1,latencyMs:1,attempts:1,fallback:false,billable:true});
 const rows=():QuestionBankServer[]=>Array.from({length:7},(_,i)=>({id:randomUUID(),userId:owner,boardId:board,boardVersion:1,cardIds:[card],type:'objective',difficulty:'medium',stem:'Synthetic question '+i,alternatives:(['A','B','C','D'] as const).map(key=>({key,text:'Synthetic '+key})),correctKey:'A',expectedAnswer:'Synthetic A',keyPoints:[],explanation:'Synthetic explanation',distractorNotes:null,evidences:[{cardId:card,excerpt:'Synthetic evidence'}],enamedAreaId:null,enamedDomainId:null,enamedCompetencyId:null,enamedTopicId:null,enamedConfidence:null,enamedConfirmed:false,source:'ai',promptId:'synthetic',promptVersion:'test',model:'test/model',status:'draft',stats:{seen:0,correct:0,partial:0,incorrect:0},version:1,supersedesId:null,createdAt:new Date()}));
 beforeAll(async()=>{db=(await import('@remoa/db')).db.$client;for(const id of [owner,other])await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@f33.example'})`;await db`INSERT INTO boards(id,user_id,title) VALUES(${board},${owner},'Synthetic board')`;await db`INSERT INTO cards(id,board_id,title) VALUES(${card},${board},'Synthetic evidence')`;});
 afterAll(async()=>{await db`DELETE FROM question_generation_runs WHERE user_id IN (${owner},${other})`;await db`DELETE FROM question_sessions WHERE user_id IN (${owner},${other})`;await db`DELETE FROM question_bank WHERE user_id IN (${owner},${other})`;await db`DELETE FROM boards WHERE id=${board}`;await db`DELETE FROM auth.users WHERE id IN (${owner},${other})`;await db.end({timeout:1});});
 it('known provider refusal permits a new attempt; uncertain response blocks all later attempts for the job',async()=>{
   const call={fn:'extract',index:0,repaired:false};const jobId=randomUUID();
   const m:ReceiptMeta={...meta('map-job:'+jobId+':attempt:1'),producer:'map_extract',context:{jobId}};
   const first=new GenerationReceipts(m).hooks();await first.load(call);await first.failed!(call,{code:'provider_error',knownNoCompletion:true});
   const retry=new GenerationReceipts({...m,requestKey:'map-job:'+jobId+':attempt:2'}).hooks();expect(await retry.load(call)).toBeNull();
   await retry.failed!(call,{code:'timeout',knownNoCompletion:false});
   const later=new GenerationReceipts({...m,requestKey:'map-job:'+jobId+':attempt:3'}).hooks();await expect(later.load(call)).rejects.toThrow('question_receipt_persistence_failed');
   const runs=await db`SELECT status FROM question_generation_runs WHERE user_id=${owner} AND request_key LIKE ${'map-job:'+jobId+':%'} ORDER BY created_at`;
   expect(runs.map(r=>r.status)).toEqual(['provider_failed','reserved']);
 });
 it('10 returned candidates = 10 durable candidates, 3 rejected + 7 private bank rows, atomic replay without duplicates',async()=>{
   const m=meta(),ledger=new GenerationReceipts(m),hooks=ledger.hooks(),call={fn:'generate',index:0,repaired:false};expect(await hooks.load(call)).toBeNull();await hooks.save(call,completion());
   await ledger.markScreened(new Map([7,8,9].map(i=>['Synthetic question '+i,{state:'rejected' as const,reason:'evidence'}])));
   const delivered=rows();await ledger.saveRows(delivered);expect(cacheInvalidations).toHaveBeenCalledWith('question.changed',{userId:owner,mapId:board});
   const stored=await db`SELECT state,count(*)::int n FROM question_generation_candidates WHERE run_id=${ledger.runs[0]!} GROUP BY state`;expect(Object.fromEntries(stored.map(r=>[r.state,r.n]))).toEqual({accepted:7,rejected:3});
   const [bank]=await db`SELECT count(*)::int n,bool_and(visibility='private' AND origin='ai_generated') private FROM question_bank WHERE user_id=${owner}`;expect(bank!.n).toBe(7);expect(bank!.private).toBe(true);
   const repeat=new GenerationReceipts(m);expect(await repeat.hooks().load(call)).toEqual(completion());const again=rows();await repeat.saveRows(again);expect(again.map(r=>r.id)).toEqual(delivered.map(r=>r.id));
   const [count]=await db`SELECT count(*)::int n FROM question_bank WHERE user_id=${owner}`;expect(count!.n).toBe(7);
   await expect(receiptStore.promote(other,ledger.runs,rows())).rejects.toThrow('question_receipt_persistence_failed');
 });
 it('DB failure after object PUT recovers through outbox; no new provider call or quota reservation',async()=>{
   const broken:ReceiptStore={...receiptStore,commit:async()=>{throw Error('synthetic DB outage');}};const ledger=new GenerationReceipts(meta(),broken);const hook=ledger.hooks(),call={fn:'generate',index:0,repaired:false};await hook.load(call);await expect(hook.save(call,completion(2))).rejects.toThrow();
   const result=await reconcileQuestionGenerations();expect(result.delivered).toBeGreaterThanOrEqual(1);
   const [run]=await db`SELECT status,received_count FROM question_generation_runs WHERE id=${ledger.runs[0]!}`;expect(run!.status).toBe('received');expect(run!.received_count).toBe(2);
   const replay=new GenerationReceipts(ledger.meta);expect((await replay.hooks().load(call))?.text).toBe(completion(2).text);
 });
 it('S3 failure fails closed; uncertain provider receipt is never automatically regenerated',async()=>{
   const ledger=new GenerationReceipts(meta(),receiptStore,{put:async()=>{throw Error('synthetic storage outage');},get:async()=>Buffer.alloc(0),exists:async()=>false});const call={fn:'generate',index:0,repaired:false},hook=ledger.hooks();await hook.load(call);await expect(hook.save(call,completion())).rejects.toThrow();await expect(new GenerationReceipts(ledger.meta).hooks().load(call)).rejects.toThrow();
   const [run]=await db`SELECT status FROM question_generation_runs WHERE id=${ledger.runs[0]!}`;expect(run!.status).toBe('reserved');
 });
 it('crash before promotion commit replays persisted promotion plan exactly once',async()=>{
   const ledger=new GenerationReceipts(meta());const hook=ledger.hooks(),call={fn:'generate',index:0,repaired:false};await hook.load(call);await hook.save(call,completion());
   const insert=receiptStore.promote;receiptStore.promote=async()=>{throw Error('synthetic crash before bank insert');};try{await expect(ledger.saveRows(rows())).rejects.toThrow();}finally{receiptStore.promote=insert;}
   const result=await reconcileQuestionGenerations();const [debug]=await db`SELECT error_code FROM question_outbox WHERE run_id=${ledger.runs[0]!} AND target='question-promotion'`;expect(debug?.error_code).toBeNull();expect(result.delivered).toBeGreaterThanOrEqual(1);const [count]=await db`SELECT count(*)::int n FROM question_generation_candidates WHERE run_id=${ledger.runs[0]!} AND state='accepted'`;expect(count!.n).toBe(7);await reconcileQuestionGenerations();const [again]=await db`SELECT count(*)::int n FROM question_generation_candidates WHERE run_id=${ledger.runs[0]!} AND state='accepted'`;expect(again!.n).toBe(7);
 });
 it('malformed original with the same stem cannot acquire the repaired candidate identity',async()=>{
   const ledger=new GenerationReceipts(meta()),hook=ledger.hooks();const original={fn:'generate',index:0,repaired:false},repair={fn:'generate',index:1,repaired:true};
   await hook.load(original);await hook.save(original,{...completion(1),text:JSON.stringify({questoes:[{enunciado:'Synthetic question 0'}]})});
   await hook.load(repair);await hook.save(repair,completion(1));const row=rows().slice(0,1);await ledger.saveRows(row);
   const [old]=await db`SELECT state,question_id FROM question_generation_candidates WHERE run_id=${ledger.runs[0]!}`;
   const [valid]=await db`SELECT id,state,question_id FROM question_generation_candidates WHERE run_id=${ledger.runs[1]!}`;
   expect(old!.state).toBe('needs_review');expect(old!.question_id).toBeNull();expect(valid!.state).toBe('accepted');expect(row[0]!.id).toBe(valid!.id);
 });
 it('map commit crash recovers only persisted cards while preserving filtered candidates',async()=>{
   const job=randomUUID();await db`INSERT INTO ai_jobs(id,user_id,kind,input,input_hash,board_id,status) VALUES(${job},${owner},'text','{}','synthetic',${board},'done')`;
   await db`UPDATE cards SET front='Synthetic extraction question',back='Synthetic extraction answer',source_excerpt='Synthetic extraction evidence' WHERE id=${card}`;
   const m:ReceiptMeta={...meta('map-job:'+job),producer:'map_extract',boardId:null,boardVersion:null};const ledger=new GenerationReceipts(m),hook=ledger.hooks(),call={fn:'extract',index:0,repaired:false};
   await hook.load(call);await hook.save(call,{...completion(),text:JSON.stringify({cards:[{question:'Synthetic extraction question',answer:'Synthetic extraction answer',sourceExcerpt:'Synthetic extraction evidence'},{question:'Synthetic filtered question',answer:'Filtered answer',sourceExcerpt:'Unresolved evidence'}]})});
   await db`UPDATE boards SET version=2 WHERE id=${board}`;await reconcileQuestionGenerations();const [run]=await db`SELECT board_id,board_version FROM question_generation_runs WHERE id=${ledger.runs[0]!}`;expect(run!.board_id).toBe(board);expect(run!.board_version).toBe(1);
   const candidates=await db`SELECT state FROM question_generation_candidates WHERE run_id=${ledger.runs[0]!} ORDER BY ordinal`;expect(candidates.map(c=>c.state)).toEqual(['accepted','needs_review']);
   await ledger.attachMap(board,1);const [count]=await db`SELECT count(*)::int n FROM question_bank WHERE user_id=${owner} AND stem='Synthetic extraction question'`;expect(count!.n).toBe(1);
   await db`DELETE FROM ai_jobs WHERE id=${job}`;
 });

 it('v2 valid HTTP evidence replays without overwriting bytes and stores the actual question count',async()=>{
   const m={...meta('v2-valid-'+randomUUID()),boardId:null,boardVersion:null,context:{}},ledger=new GenerationReceipts(m),hook=ledger.hooks(),call={fn:'generate',index:0,repaired:false};await hook.load(call);
   const envelope=await captureHttpEnvelope(Response.json({model:'test/model',choices:[{message:{content:completion(2).text}}]}),{model:'test/model',attempts:1,fallback:false,latencyMs:1});await hook.saveEnvelope!(call,envelope);
   const [stored]=await db`SELECT status,received_count,payload_hash,payload_object_key FROM question_generation_runs WHERE id=${ledger.runs[0]!} AND user_id=${owner}`;expect(stored!.status).toBe('received');expect(stored!.received_count).toBe(2);
   const original=objects.get(String(stored!.payload_object_key))!;expect(JSON.parse(original.toString()).completion).toBeUndefined();expect(receiptHash(original)).toBe(stored!.payload_hash);
   const replay=await new GenerationReceipts(m).hooks().load(call);expect(replay!.text).toBe(completion(2).text);expect(objects.get(String(stored!.payload_object_key))).toEqual(original);
 });
 it.each(['invalid','incomplete'] as const)('v2 %s evidence remains quarantined with zero identified questions',async kind=>{
   const m={...meta('v2-'+kind+'-'+randomUUID()),boardId:null,boardVersion:null,context:{}},ledger=new GenerationReceipts(m),hook=ledger.hooks(),call={fn:'generate',index:0,repaired:false};await hook.load(call);
   const raw=await captureHttpEnvelope(new Response('partial invalid evidence'),{model:'test/model',attempts:1,fallback:false,latencyMs:1}),envelope=kind==='incomplete'?{...raw,bodyComplete:false,errorCode:'body_read_failed' as const}:raw;await hook.saveEnvelope!(call,envelope);
   const [stored]=await db`SELECT status,received_count,error_code,payload_object_key FROM question_generation_runs WHERE id=${ledger.runs[0]!} AND user_id=${owner}`;expect(stored!.status).toBe('quarantined');expect(stored!.received_count).toBe(0);expect(stored!.error_code).toBe(kind==='incomplete'?'body_read_failed':'invalid_http_envelope');
   const bytes=objects.get(String(stored!.payload_object_key))!;expect(JSON.parse(bytes.toString()).envelope.bodyComplete).toBe(kind!=='incomplete');await expect(new GenerationReceipts(m).hooks().load(call)).rejects.toThrow();expect(objects.get(String(stored!.payload_object_key))).toEqual(bytes);
 });
 it('hard-deleting a map preserves its questions linked by sessions and generation candidates',async()=>{
   const [question]=await db`SELECT id FROM question_bank WHERE user_id=${owner} AND board_id=${board} LIMIT 1`;expect(question).toBeDefined();
   const [session]=await db`INSERT INTO question_sessions(user_id,mode,config,idempotency_key) VALUES(${owner},'study','{}',${randomUUID()}) RETURNING id`;
   await db`INSERT INTO question_session_items(user_id,session_id,question_id,position,payload_public,reference_snapshot) VALUES(${owner},${session!.id},${question!.id},0,'{}','{}')`;
   await db`DELETE FROM boards WHERE id=${board}`;const [saved]=await db`SELECT board_id FROM question_bank WHERE id=${question!.id}`;expect(saved!.board_id).toBeNull();expect((await db`SELECT id FROM question_session_items WHERE session_id=${session!.id}`).length).toBe(1);expect((await db`SELECT id FROM question_generation_candidates WHERE question_id=${question!.id}`).length).toBeGreaterThan(0);
 });

 it('legacy negative discovery rotates past LIMIT, survives restart and finds a plan created after HEAD',async()=>{
   const ids=Array.from({length:3},()=>randomUUID());
   for(const [index,id]of ids.entries()){
     const record={version:1,runId:id,meta:meta('legacy-scan-'+id),call:{fn:'generate',index:0,repaired:false},completion:completion(1)};
     const key=`questions/generation/${owner}/${id}/receipt.json`,bytes=Buffer.from(JSON.stringify(record));objects.set(key,bytes);
     await db`INSERT INTO question_generation_runs(id,user_id,producer,request_key,prompt_id,prompt_version,model,provider,payload_object_key,payload_hash,status,created_at) VALUES(${id},${owner},'challenge_objective',${'legacy-scan-'+id},'synthetic','test','test/model','openrouter',${key},${receiptHash(bytes)},'received',${new Date(new Date('2000-01-01T00:00:00.000Z').getTime()+index)})`;
     await db`INSERT INTO question_generation_candidates(run_id,ordinal,payload_object_key,state) VALUES(${id},0,${key},'pending')`;
   }
   // More runs than limit; negative markers rotate instead of permanently suppressing discovery.
   for(let index=0;index<10;index++){
     await reconcileQuestionGenerations(1);
     const own=await db`SELECT id FROM question_outbox WHERE target='question-promotion-discovery' AND run_id IN (${ids[0]!},${ids[1]!},${ids[2]!})`;
     if(own.length===3)break;
   }
   const marks=await db`SELECT run_id,delivered_at,lease_until FROM question_outbox WHERE target='question-promotion-discovery' AND run_id IN (${ids[0]!},${ids[1]!},${ids[2]!})`;
   expect(marks).toHaveLength(3);expect(marks.every(m=>m.delivered_at===null&&m.lease_until)).toBe(true);
   const late=ids[0]!,lateRows=rows().slice(0,1),key=`questions/generation/${owner}/${late}/promotion.json`;
   objects.set(key,Buffer.from(JSON.stringify({ownerId:owner,runIds:[late],rows:lateRows})));
   await db`UPDATE question_outbox SET lease_until=now()-interval '1 second',updated_at=timestamptz '2000-01-01' WHERE target='question-promotion-discovery' AND run_id=${late}`;
   const restarted=await reconcileQuestionGenerations(1);expect(restarted.discovered).toBe(1);
   await reconcileQuestionGenerations(50);
   const [saved]=await db`SELECT state,question_id FROM question_generation_candidates WHERE run_id=${late}`;expect(saved!.state).toBe('accepted');
   const [question]=await db`SELECT visibility,origin FROM question_bank WHERE id=${saved!.question_id}`;expect(question).toMatchObject({visibility:'private',origin:'ai_generated'});
 });

 it.each(['provider_failed','reserved'] as const)('promotes the first valid response despite a later %s run, preserving uncertain inventory',async status=>{
   const ledger=new GenerationReceipts(meta()),hooks=ledger.hooks();
   const first={fn:'generate',index:0,repaired:false};await hooks.load(first);await hooks.save(first,completion(1));
   const later={fn:'generate',index:1,repaired:false};await hooks.load(later);await hooks.failed!(later,{code:status==='reserved'?'timeout':'provider_error',knownNoCompletion:status==='provider_failed'});
   const inventory=[...ledger.runs],savedRows=rows().slice(0,1);await ledger.saveRows(savedRows);
   expect(ledger.runs).toEqual(inventory);
   const [good]=await db`SELECT status FROM question_generation_runs WHERE id=${inventory[0]!}`;
   const [pending]=await db`SELECT status,payload_hash FROM question_generation_runs WHERE id=${inventory[1]!}`;
   expect(good!.status).toBe('completed');expect(pending).toMatchObject({status,payload_hash:null});
   const [question]=await db`SELECT visibility,origin FROM question_bank WHERE id=${savedRows[0]!.id}`;expect(question).toMatchObject({visibility:'private',origin:'ai_generated'});
   await ledger.saveRows(rows().slice(0,1)); // fresh bank projection, exact receipt replay; no new provider run
   const [count]=await db`SELECT count(*)::int n FROM question_generation_runs WHERE id IN (${inventory[0]!},${inventory[1]!})`;expect(count!.n).toBe(2);
 });

});
