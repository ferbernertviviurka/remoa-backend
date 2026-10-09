import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {generateJson,captureHttpEnvelope,type HttpCompletionEnvelope} from '@remoa/ai';
vi.mock('../../db',()=>({run:vi.fn(),asServer:vi.fn()}));vi.mock('../../cache',()=>({invalidate:vi.fn()}));
import {GenerationReceipts,receiptHash,receiptEvidence,decodeReceiptRecord,receivedQuestionCount,type ReceiptMeta,type ReceiptRecord,type ReceiptStore,type ReceiptObjects} from './receipts';
const env={...process.env};beforeEach(()=>{process.env.OPENROUTER_API_KEY='synthetic';process.env.AI_BASE_URL='https://synthetic.invalid/v1';process.env.AI_MODEL='test/model';process.env.AI_MODEL_FALLBACKS='';process.env.AI_REQUIRE_FREE='false';process.env.AI_MAX_RETRIES='0';});afterEach(()=>{process.env={...env};});
const owner=randomUUID(),id=randomUUID();const meta:ReceiptMeta={ownerId:owner,producer:'map_extract',requestKey:'synthetic',promptId:'synthetic',promptVersion:'1',boardId:null,boardVersion:null};
function memory(){
 let reserved=false,hash:string|undefined,quarantined=false;const files=new Map<string,Buffer>(),key=`questions/generation/${owner}/${id}/receipt.json`,commits:{record:ReceiptRecord;count:number;quarantine:string|null}[]=[];
 const store:ReceiptStore={reserve:vi.fn(async()=>{if(quarantined)throw Error('receipt_quarantined');const created=!reserved;reserved=true;if(!created&&!hash)throw Error('receipt_pending_reconciliation');return{id,objectKey:key,replay:null,created,hash};}),commit:vi.fn(async(record,_key,digest,candidates,quarantine)=>{hash=digest;quarantined=Boolean(quarantine);commits.push({record,count:receivedQuestionCount(candidates),quarantine});}),promote:vi.fn()};
 const storage:ReceiptObjects={put:vi.fn(async(k,b)=>{files.set(k,b);}),get:vi.fn(async k=>{if(!files.has(k))throw Error('missing');return files.get(k)!;}),exists:async k=>files.has(k)};
 return{store,storage,files,key,commits};
}
const options=(fetchImpl:typeof fetch)=>({fn:'extract' as const,system:'private',user:'private',fetchImpl});
describe('durable transport receipt v2',()=>{
 it.each(['unicode','escaped'] as const)('rejects oversized %s metadata before reservation, reads or provider',async kind=>{
  const m=memory(),fetchImpl=vi.fn(),text=kind==='unicode'?'é'.repeat(2_200_000):'\u0000'.repeat(800_000);
  await expect(new GenerationReceipts({...meta,context:{text}},m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(fetchImpl)))).rejects.toMatchObject({reason:'receipt_metadata_limit'});
  expect(m.store.reserve).not.toHaveBeenCalled();expect(m.storage.get).not.toHaveBeenCalled();expect(m.storage.put).not.toHaveBeenCalled();expect(fetchImpl).not.toHaveBeenCalled();
 });
 it('restarts after immutable raw checkpoint and returns decoded completion without another PUT/provider',async()=>{
  const m=memory(),fetchImpl=vi.fn(async()=>Response.json({choices:[{message:{content:'{"cards":[{"question":"one"}]}'}}],usage:{prompt_tokens:2,completion_tokens:3}}));const first=new GenerationReceipts(meta,m.store,m.storage);
  const schema=z.object({cards:z.array(z.object({question:z.string()}))});const result=await first.wrap(()=>generateJson(schema,options(fetchImpl)));expect(result.data.cards).toHaveLength(1);expect(m.commits[0]).toMatchObject({count:1,quarantine:null});
  const raw=m.files.get(m.key)!;const saved=JSON.parse(raw.toString()) as ReceiptRecord;expect(saved.version).toBe(2);expect(saved.completion).toBeUndefined();expect(saved.envelope?.bodyComplete).toBe(true);expect(raw.toString()).not.toContain('private');expect(m.storage.put).toHaveBeenCalledOnce();
  const restarted=new GenerationReceipts(meta,m.store,m.storage);const neverFetch=vi.fn();const replay=await restarted.wrap(()=>generateJson(schema,options(neverFetch)));expect(replay.data).toEqual(result.data);expect(neverFetch).not.toHaveBeenCalled();expect(m.storage.put).toHaveBeenCalledOnce();expect(m.files.get(m.key)).toEqual(raw);
 });
 it.each(['not json','null','{"choices":[]}','{"error":{"message":"synthetic"}}'])('HTTP200 %s remains durable quarantined with zero questions, no repair/retry',async body=>{
  const m=memory(),fetchImpl=vi.fn(async()=>new Response(body));await expect(new GenerationReceipts(meta,m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(fetchImpl)))).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledOnce();expect(m.storage.put).toHaveBeenCalledOnce();expect(m.commits[0]).toMatchObject({count:0,quarantine:'invalid_http_envelope'});const record=JSON.parse(m.files.get(m.key)!.toString()) as ReceiptRecord;expect(Buffer.from(record.envelope!.bodyBase64,'base64').toString()).toBe(body);
  const neverFetch=vi.fn();await expect(new GenerationReceipts(meta,m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(neverFetch)))).rejects.toThrow();expect(neverFetch).not.toHaveBeenCalled();
 });
 it('persists interrupted HTTP200 body as incomplete evidence, never terminal refusal or repair',async()=>{
  let reads=0;const body=new ReadableStream<Uint8Array>({pull(c){if(reads++===0)c.enqueue(new TextEncoder().encode('partial'));else c.error(Error('connection reset'));}});const m=memory(),fetchImpl=vi.fn(async()=>new Response(body));
  await expect(new GenerationReceipts(meta,m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(fetchImpl)))).rejects.toThrow();expect(fetchImpl).toHaveBeenCalledOnce();expect(m.commits[0]).toMatchObject({count:0,quarantine:'body_read_failed'});
  const saved=JSON.parse(m.files.get(m.key)!.toString()) as ReceiptRecord;expect(saved.envelope).toMatchObject({bodyComplete:false,errorCode:'body_read_failed',bodyBytes:7});expect(Buffer.from(saved.envelope!.bodyBase64,'base64').toString()).toBe('partial');expect(saved.completion).toBeUndefined();
 });
 it('conserves raw bytes after PUT-before-commit crash, reconciliation derives without overwriting',async()=>{
  const m=memory();m.store.commit=vi.fn(async()=>{throw Error('crash before commit');});await expect(new GenerationReceipts(meta,m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(async()=>Response.json({choices:[{message:{content:'{"cards":[]}'}}]}))))).rejects.toThrow();
  const bytes=m.files.get(m.key)!;const evidence=receiptEvidence(JSON.parse(bytes.toString()) as ReceiptRecord);expect(evidence.record.completion.text).toBe('{"cards":[]}');expect(receivedQuestionCount(evidence.candidates)).toBe(0);expect(evidence.quarantine).toBeNull();expect(m.storage.put).toHaveBeenCalledOnce();
  const neverFetch=vi.fn();await expect(new GenerationReceipts(meta,m.store,m.storage).wrap(()=>generateJson(z.object({cards:z.array(z.unknown())}),options(neverFetch)))).rejects.toMatchObject({reason:'receipt_load_failed'});expect(neverFetch).not.toHaveBeenCalled();
 });
 it('rejects a second envelope for the same checkpoint without rewriting original bytes',async()=>{
  const m=memory(),hooks=new GenerationReceipts(meta,m.store,m.storage).hooks(),call={fn:'extract',index:0,repaired:false};await hooks.load(call);
  const envelope=await captureHttpEnvelope(Response.json({choices:[{message:{content:'{"cards":[]}'}}]}),{model:'test/model',attempts:1,fallback:false,latencyMs:1});await hooks.saveEnvelope!(call,envelope);const original=m.files.get(m.key)!;
  await expect(hooks.saveEnvelope!(call,{...envelope,bodyBase64:Buffer.from('different').toString('base64'),bodyBytes:9})).rejects.toMatchObject({reason:'receipt_envelope_already_saved'});expect(m.storage.put).toHaveBeenCalledOnce();expect(m.files.get(m.key)).toEqual(original);
 });
 it('refuses SHA or owner/context/call changes before returning stored completion',async()=>{
  const m=memory(),hooks=new GenerationReceipts(meta,m.store,m.storage).hooks(),call={fn:'extract',index:0,repaired:false};await hooks.load(call);await hooks.save(call,{text:'{"cards":[]}',model:'test/model',tokensIn:0,tokensOut:0,latencyMs:1,attempts:1,fallback:false,billable:true});
  const bytes=m.files.get(m.key)!;m.files.set(m.key,Buffer.from(bytes.toString()+' '));await expect(new GenerationReceipts(meta,m.store,m.storage).hooks().load(call)).rejects.toMatchObject({reason:'receipt_hash_invalid'});m.files.set(m.key,bytes);
  await expect(new GenerationReceipts({...meta,ownerId:randomUUID()},m.store,m.storage).hooks().load(call)).rejects.toMatchObject({reason:'receipt_owner_mismatch'});await expect(new GenerationReceipts({...meta,context:{changed:true}},m.store,m.storage).hooks().load(call)).rejects.toMatchObject({reason:'receipt_load_failed'});await expect(new GenerationReceipts(meta,m.store,m.storage).hooks().load({...call,repaired:true})).rejects.toMatchObject({reason:'receipt_load_failed'});
 });
 it('retains v1 replay and quarantines incomplete envelope without pretending completion exists',async()=>{
  const envelope:HttpCompletionEnvelope=await captureHttpEnvelope(new Response('partial'),{model:'test/model',attempts:1,fallback:false,latencyMs:1});const record:ReceiptRecord={version:2,runId:id,meta,call:{fn:'extract',index:0,repaired:false},completion:{text:'',model:'test/model',tokensIn:0,tokensOut:0,latencyMs:1,attempts:1,fallback:false,billable:true},envelope:{...envelope,bodyComplete:false,errorCode:'body_read_failed'}};
  const evidence=receiptEvidence(record);expect(evidence.quarantine).toBe('body_read_failed');expect(receivedQuestionCount(evidence.candidates)).toBe(0);expect(()=>decodeReceiptRecord(record)).toThrow();expect(decodeReceiptRecord({...record,version:1,envelope:undefined,completion:{...record.completion,text:'{"cards":[]}'}}).completion.text).toBe('{"cards":[]}');expect(receiptHash('same')).toHaveLength(64);
 });
});
