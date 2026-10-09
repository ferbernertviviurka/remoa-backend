import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import type {QuestionBankServer} from '@remoa/contracts';
const db=vi.hoisted(()=>({results:[] as Record<string,unknown>[][],calls:[] as unknown[]}));
vi.mock('../../db',()=>({run:async(_owner:string,fn:(tx:unknown)=>unknown)=>fn({}),asServer:async(_tx:unknown,q:unknown)=>{db.calls.push(q);return db.results.shift()??[];},dbm:async()=>({})}));
vi.mock('../../cache',()=>({invalidate:vi.fn()}));
import {savePromotion,receiptCandidates,loadReceivedRecords,receiptStore,promotionStore,receiptHash,type PromotionPort,type ReceiptObjects,type ReceiptRecord} from './receipts';
import {discoverLegacyPromotion} from './reconcile';
const owner=randomUUID(),runId=randomUUID(),board=randomUUID(),card=randomUUID();
function row():QuestionBankServer{return{id:randomUUID(),userId:owner,boardId:board,boardVersion:1,cardIds:[card],type:'objective',difficulty:'medium',stem:'Synthetic question',alternatives:[{key:'A',text:'one'},{key:'B',text:'two'},{key:'C',text:'three'},{key:'D',text:'four'}],correctKey:'A',expectedAnswer:'one',keyPoints:[],explanation:'Synthetic evidence',distractorNotes:null,evidences:[{cardId:card,excerpt:"Synthetic evidence"}],enamedAreaId:null,enamedDomainId:null,enamedCompetencyId:null,enamedTopicId:null,enamedConfidence:null,enamedConfirmed:false,source:'ai',promptId:'synthetic',promptVersion:'1',model:'test/model',status:'draft',stats:{seen:0,correct:0,partial:0,incorrect:0},version:1,supersedesId:null,createdAt:new Date()};}
function memory(){
 const files=new Map<string,Buffer>();let saved:{reference:string;delivered:boolean}|null=null;const order:string[]=[];
 const port:PromotionPort={load:vi.fn(async()=>saved),reserve:vi.fn(async(_owner,_runs,reference)=>{order.push('reserve');if(saved&&saved.reference!==reference)throw Error('plan changed');return saved??={reference,delivered:false};}),delivered:vi.fn(async()=>{order.push('ack');saved!.delivered=true;})};
 const storage:ReceiptObjects={exists:vi.fn(async key=>files.has(key)),get:vi.fn(async key=>{if(!files.has(key))throw Error('missing');return files.get(key)!;}),put:vi.fn(async(key,bytes)=>{order.push('put');files.set(key,bytes);})};
 const promote=vi.fn(async(_owner:string,_runs:string[],rows:readonly QuestionBankServer[])=>{order.push('promote');for(const q of rows)q.id=runId;});
 return{port,storage,promote,files,order,get saved(){return saved;}};
}
describe('immutable durable promotion plan',()=>{
 it('reserves before PUT; a fresh caller recovers crash immediately after PUT',async()=>{
  const m=memory(),rows=[row()];m.storage.put=vi.fn(async(key,bytes)=>{m.order.push('put');m.files.set(key,bytes);throw Error('process died after PUT');});
  await expect(savePromotion(owner,[runId],rows,m.storage,m.port,m.promote)).rejects.toThrow();expect(m.order).toEqual(['reserve','put']);expect(m.promote).not.toHaveBeenCalled();
  const freshStorage={...m.storage,put:vi.fn()};await savePromotion(owner,[runId],[{...rows[0]!,id:randomUUID(),createdAt:new Date('2030-01-01')}],freshStorage,m.port,m.promote);
  expect(freshStorage.put).not.toHaveBeenCalled();expect(m.saved!.delivered).toBe(true);expect(m.promote).toHaveBeenCalledTimes(1);
 });
 it('reproduces legacy PUT-before-insert, then discovers the plan independently of receipt delivery',async()=>{
  const m=memory(),rows=[row()],key=`questions/generation/${owner}/${runId}/promotion.json`;
  expect(await discoverLegacyPromotion(owner,runId,m.storage,m.port)).toBe(false);expect(m.saved).toBeNull();
  const legacyPutThenInsert=async()=>{await m.storage.put(key,Buffer.from(JSON.stringify({ownerId:owner,runIds:[runId],rows})));throw Error('legacy crash before outbox INSERT');};
  await expect(legacyPutThenInsert()).rejects.toThrow();expect(m.saved).toBeNull();vi.mocked(m.storage.put).mockClear();
  expect(await discoverLegacyPromotion(owner,runId,m.storage,m.port)).toBe(true);
  await savePromotion(owner,[runId],rows,m.storage,m.port,m.promote);expect(m.storage.put).not.toHaveBeenCalled();expect(m.saved!.delivered).toBe(true);
 });
 it.each(['stem','expectedAnswer','correctKey','alternatives','evidences'] as const)('rejects changed %s before overwriting a plan',async field=>{
  const m=memory(),rows=[row()];await savePromotion(owner,[runId],rows,m.storage,m.port,m.promote);vi.mocked(m.storage.put).mockClear();m.promote.mockClear();
  const changed={...rows[0]!};if(field==='alternatives')changed.alternatives=[...changed.alternatives!].reverse();else if(field==='evidences')changed.evidences=[{cardId:randomUUID(),excerpt:'changed'}];else if(field==='correctKey')changed.correctKey='B';else changed[field]='changed';
  const snapshot=[...m.files.entries()].map(([key,b])=>[key,b.toString()]);await expect(savePromotion(owner,[runId],[changed],m.storage,m.port,m.promote)).rejects.toThrow();
  expect(m.storage.put).not.toHaveBeenCalled();expect(m.promote).not.toHaveBeenCalled();expect([...m.files.entries()].map(([key,b])=>[key,b.toString()])).toEqual(snapshot);
 });
 it('concurrent identical plans reuse one content key',async()=>{
  const m=memory(),rows=[row()];await Promise.all([savePromotion(owner,[runId],rows,m.storage,m.port,m.promote),savePromotion(owner,[runId],structuredClone(rows),m.storage,m.port,m.promote)]);expect(m.files.size).toBe(1);expect(m.saved!.reference).toMatch(/promotion-[a-f0-9]{64}\.json#/);
 });
 it('conflicting concurrent plan loses before writing',async()=>{
  const m=memory(),a=[row()],b=[{...a[0]!,stem:'different'}];const results=await Promise.allSettled([savePromotion(owner,[runId],a,m.storage,m.port,m.promote),savePromotion(owner,[runId],b,m.storage,m.port,m.promote)]);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(m.files.size).toBe(1);expect(m.storage.put).toHaveBeenCalledTimes(1);
 });
 it('corrupted cached bytes are not overwritten',async()=>{
  const m=memory(),rows=[row()];await savePromotion(owner,[runId],rows,m.storage,m.port,m.promote);m.files.set(m.saved!.reference.split('#')[0]!,Buffer.from('corrupted'));vi.mocked(m.storage.put).mockClear();await expect(savePromotion(owner,[runId],rows,m.storage,m.port,m.promote)).rejects.toThrow();expect(m.storage.put).not.toHaveBeenCalled();
 });
 it('legacy foreign owner cannot register a plan',async()=>{
  const m=memory(),key=`questions/generation/${owner}/${runId}/promotion.json`;m.files.set(key,Buffer.from(JSON.stringify({ownerId:randomUUID(),runIds:[runId],rows:[row()]})));await expect(discoverLegacyPromotion(owner,runId,m.storage,m.port)).rejects.toThrow();expect(m.port.reserve).not.toHaveBeenCalled();
 });
 it('lost receipt lease stops before updates or acknowledgement',async()=>{
  db.calls.length=0;db.results=[[{id:runId,payload_hash:null}],[]];const record={runId,meta:{ownerId:owner},completion:{text:'synthetic'}} as ReceiptRecord;
  await expect(receiptStore.commit(record,'key',receiptHash('text'),[],null,{outboxId:randomUUID(),workerId:randomUUID()})).rejects.toThrow();expect(db.calls).toHaveLength(2);expect(db.results).toHaveLength(0);
 });
 it('lost discovery lease cannot create a promotion reservation',async()=>{
  db.calls.length=0;db.results=[[{id:runId,payload_hash:'known-hash'}],[]];
  await expect(promotionStore.reserve(owner,[runId],'private-ref',{outboxId:randomUUID(),workerId:randomUUID()})).rejects.toThrow();
  expect(db.calls).toHaveLength(2); // owner/receipt check and lease check only; no insert/update
 });

 it('reservation without successful PUT stays pending and never overwrites or promotes on retry',async()=>{
  const m=memory(),rows=[row()];m.storage.put=vi.fn(async()=>{throw Error('storage unavailable before checkpoint');});
  await expect(savePromotion(owner,[runId],rows,m.storage,m.port,m.promote)).rejects.toThrow();
  expect(m.saved).not.toBeNull();expect(m.saved!.delivered).toBe(false);
  await expect(savePromotion(owner,[runId],rows,m.storage,m.port,m.promote)).rejects.toThrow();
  expect(m.storage.put).toHaveBeenCalledTimes(1);expect(m.promote).not.toHaveBeenCalled();expect(m.port.delivered).not.toHaveBeenCalled();
 });

 it('multi-run reservation binds an actual UUID array, locks runs first and preserves existing hash reference',async()=>{
  const second=randomUUID(),reference=`questions/generation/${owner}/${runId}/promotion-${'a'.repeat(64)}.json#${'a'.repeat(64)}`;
  db.calls.length=0;db.results=[[{id:runId,payload_hash:'known'},{id:second,payload_hash:'known'}],[],[{payload_reference:reference,delivered_at:null}]];
  await expect(promotionStore.reserve(owner,[runId,second],reference)).resolves.toMatchObject({reference});
  const dialect=new PgDialect(),queries=db.calls.map(q=>dialect.sqlToQuery(q as SQL));
  expect(queries[0]!.sql).toContain('ANY(ARRAY[');expect(queries[0]!.sql).toContain('ORDER BY id FOR UPDATE');
  expect(queries[0]!.params).toEqual([owner,runId,second]);expect(queries[1]!.sql).toContain('ON CONFLICT(event_key) DO NOTHING');
 });

 it.each(['provider_failed','reserved'] as const)('valid first receipt survives later %s across fresh membership loading',async status=>{
  const m=memory(),uncertain=randomUUID();
  const record:ReceiptRecord={version:1,runId,meta:{ownerId:owner,producer:'challenge_objective',requestKey:'synthetic-first',promptId:'synthetic',promptVersion:'1',boardId:board,boardVersion:1},call:{fn:'generate',index:0,repaired:false},completion:{text:JSON.stringify({questoes:[{enunciado:'Synthetic question',dificuldade:'medio',cards:['c1'],evidencias:[{card:'c1',trecho:'Synthetic evidence'}],alternativas:{A:'one',B:'two',C:'three',D:'four'},correta:'A',explicacao_correta:'Synthetic evidence'}]}),model:'test/model',tokensIn:1,tokensOut:1,latencyMs:1,attempts:1,fallback:false,billable:true}};
  const key=`questions/generation/${owner}/${runId}/receipt.json`,bytes=Buffer.from(JSON.stringify(record));m.files.set(key,bytes);
  const members=[{id:runId,producer:'challenge_objective',request_key:'synthetic-first:0:0',prompt_id:'synthetic',prompt_version:'1',status:'received',payload_object_key:key,payload_hash:receiptHash(bytes)},{id:uncertain,status,payload_hash:null,payload_object_key:`questions/generation/${owner}/${uncertain}/receipt.json`}];
  const load=vi.fn(async()=>structuredClone(members));
  const result=await loadReceivedRecords(owner,[runId,uncertain],m.storage,load);
  expect(result.runIds).toEqual([runId]);expect(result.records).toEqual([record]);expect(m.storage.get).toHaveBeenCalledTimes(1);
  const restarted=await loadReceivedRecords(owner,[runId,uncertain],m.storage,load);expect(restarted.runIds).toEqual([runId]);
  await savePromotion(owner,restarted.runIds,[row()],m.storage,m.port,m.promote);
  expect(members[1]!.status).toBe(status);expect(m.promote.mock.calls[0]![1]).toEqual([runId]);
  expect(m.files.has(`questions/generation/${owner}/${uncertain}/receipt.json`)).toBe(false);
 });
 it.each(['hash','metadata'] as const)('received %s mismatch prevents restoration/promotion',async failure=>{
  const m=memory(),key=`questions/generation/${owner}/${runId}/receipt.json`;
  const raw={version:1,runId,meta:{ownerId:failure==='metadata'?randomUUID():owner,producer:'challenge_objective',promptId:'synthetic',promptVersion:'1',requestKey:'req'},call:{fn:'generate',index:0,repaired:false},completion:{text:'synthetic'}};
  const bytes=Buffer.from(JSON.stringify(raw));m.files.set(key,bytes);
  const member={id:runId,producer:'challenge_objective',request_key:'req:0:0',prompt_id:'synthetic',prompt_version:'1',status:'received',payload_object_key:key,payload_hash:failure==='hash'?'a'.repeat(64):receiptHash(bytes)};
  await expect(loadReceivedRecords(owner,[runId],m.storage,async()=>[member])).rejects.toThrow();expect(m.promote).not.toHaveBeenCalled();
 });
 it('quarantined and reserved runs remain in inventory without reading or completing them',async()=>{
  const m=memory(),other=randomUUID(),inventory=[runId,other];const members=[{id:runId,status:'quarantined'},{id:other,status:'reserved'}];
  expect((await loadReceivedRecords(owner,inventory,m.storage,async()=>members)).runIds).toEqual([]);
  expect(inventory).toEqual([runId,other]);expect(m.storage.get).not.toHaveBeenCalled();expect(m.port.delivered).not.toHaveBeenCalled();
 });

});


describe('received_count SQL projection',()=>{
 it.each([['{"cards":[]}',0],['not JSON',0],['{"cards":[null]}',1]] as const)('stores identified count for %s as %i',async(text,count)=>{
  db.calls.length=0;db.results=[[{id:runId,payload_hash:null}],[],[],[]];
  const record={version:1,runId,meta:{ownerId:owner,producer:'map_extract'},completion:{text,model:'synthetic'}} as ReceiptRecord;
  await receiptStore.commit(record,'private-key',receiptHash(text),receiptCandidates(text,'map_extract'),null);
  const query=new PgDialect().sqlToQuery(db.calls[1] as SQL);const slot=query.sql.match(/received_count=\$(\d+)/);expect(slot).not.toBeNull();expect(query.params[Number(slot![1])-1]).toBe(count);
 });
});
