import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {z} from 'zod';
import {captureHttpEnvelope,HTTP_RECEIPT_MAX_BODY_BYTES,type HttpCompletionEnvelope} from './http-envelope';
import {completionFromEnvelope,generateJson,resetUsage} from './client';
import {withCompletionReceipts,ReceiptPersistenceError} from './receipts';
const env={...process.env};const meta={model:'test/model',attempts:1,fallback:false,latencyMs:1};
beforeEach(()=>{resetUsage();process.env.OPENROUTER_API_KEY='synthetic';process.env.AI_MODEL='test/model';process.env.AI_MODEL_FALLBACKS='test/second';process.env.AI_REQUIRE_FREE='false';process.env.AI_MAX_RETRIES='2';});
afterEach(()=>{process.env={...env};});
const opts=(fetchImpl:typeof fetch)=>({fn:'generate' as const,system:'private prompt',user:'private user',fetchImpl,sleep:async()=>{}});
describe('HTTP evidence before decoding',()=>{
 it.each(['not JSON','null','{}','{"choices":[]}','{"choices":[{"message":{"content":""}}]}','{"error":{"code":502,"message":"synthetic failure"}}'])('conserves HTTP200 %s without retry or repair',async body=>{
  const envelopes:HttpCompletionEnvelope[]=[],save=vi.fn(),failed=vi.fn(),fetchImpl=vi.fn(async()=>new Response(body,{headers:{'set-cookie':'private','content-type':'application/json','authorization':'private'}}));
  await expect(withCompletionReceipts({load:async()=>null,save,failed,saveEnvelope:async(_call,value)=>{envelopes.push(value);}},()=>generateJson(z.object({n:z.number()}),opts(fetchImpl)))).rejects.toThrow();
  expect(envelopes).toHaveLength(1);expect(Buffer.from(envelopes[0]!.bodyBase64,'base64').toString()).toBe(body);expect(envelopes[0]!.bodyComplete).toBe(true);expect(JSON.stringify(envelopes)).not.toContain('private');expect(fetchImpl).toHaveBeenCalledTimes(1);expect(save).not.toHaveBeenCalled();expect(failed.mock.calls[0]![1].knownNoCompletion).toBe(false);
 });
 it('awaits checkpoint before interpreting JSON or invoking schema',async()=>{
  let release!:()=>void;const checkpoint=new Promise<void>(r=>{release=r;});let entered!:()=>void;const entry=new Promise<void>(r=>{entered=r;});const schemaTransform=vi.fn(v=>v),save=vi.fn();
  const result=withCompletionReceipts({load:async()=>null,save,saveEnvelope:async()=>{entered();await checkpoint;}},()=>generateJson(z.object({n:z.number()}).transform(schemaTransform),opts(async()=>Response.json({choices:[{message:{content:'{"n":1}'}}]}))));
  await entry;expect(save).not.toHaveBeenCalled();expect(schemaTransform).not.toHaveBeenCalled();release();expect((await result).data.n).toBe(1);expect(save).toHaveBeenCalledOnce();
 });
 it('checkpoint failure prevents interpretation, repair and fallback',async()=>{
  const fetchImpl=vi.fn(async()=>new Response('not json')),save=vi.fn();
  await expect(withCompletionReceipts({load:async()=>null,save,saveEnvelope:async()=>{throw Error('storage unavailable');}},()=>generateJson(z.object({n:z.number()}),opts(fetchImpl)))).rejects.toBeInstanceOf(ReceiptPersistenceError);
  expect(fetchImpl).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();
 });
 it('keeps exact invalid UTF8 bytes and rejects their interpretation',async()=>{
  const bytes=new Uint8Array([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]);const envelope=await captureHttpEnvelope(new Response(bytes),meta);expect(Buffer.from(envelope.bodyBase64,'base64')).toEqual(Buffer.from(bytes));expect(()=>completionFromEnvelope(envelope)).toThrow('invalid_output');
 });
 it('records bounded oversize evidence explicitly without retry',async()=>{
  const bytes=new Uint8Array(HTTP_RECEIPT_MAX_BODY_BYTES+1).fill(65);const envelope=await captureHttpEnvelope(new Response(bytes),meta);expect(envelope.bodyComplete).toBe(false);expect(envelope.errorCode).toBe('body_limit');expect(envelope.bodyBytes).toBe(HTTP_RECEIPT_MAX_BODY_BYTES);expect(()=>completionFromEnvelope(envelope)).toThrow('body_limit');
 });
 it('conserves HTTP200 with no body as zero complete bytes, no fabricated answer',async()=>{
  const envelope=await captureHttpEnvelope(new Response(null),meta);expect(envelope).toMatchObject({bodyComplete:true,bodyBytes:0,bodyBase64:'',errorCode:null});expect(()=>completionFromEnvelope(envelope)).toThrow('invalid_output');
 });
 it('bounds a multi-chunk body at exactly the cap even if cancellation fails',async()=>{
  let n=0;const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(n++===0?new Uint8Array(HTTP_RECEIPT_MAX_BODY_BYTES):new Uint8Array([1]));},cancel(){throw Error('cancel failed');}});const envelope=await captureHttpEnvelope(new Response(stream),meta);expect(envelope.bodyBytes).toBe(HTTP_RECEIPT_MAX_BODY_BYTES);expect(envelope).toMatchObject({bodyComplete:false,errorCode:'body_limit'});
 });
 it('retains bytes delivered before interrupted stream and labels incomplete',async()=>{
  let reads=0;const body=new ReadableStream<Uint8Array>({pull(c){if(reads++===0)c.enqueue(new TextEncoder().encode('partial evidence'));else c.error(Error('connection closed'));}});const envelope=await captureHttpEnvelope(new Response(body),meta);expect(Buffer.from(envelope.bodyBase64,'base64').toString()).toBe('partial evidence');expect(envelope.bodyComplete).toBe(false);expect(envelope.errorCode).toBe('body_read_failed');expect(()=>completionFromEnvelope(envelope)).toThrow();
 });
 it('bounds the complete body read deadline and labels pending stream evidence',async()=>{
  const envelope=await captureHttpEnvelope(new Response(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}})),meta,10);expect(envelope.bodyComplete).toBe(false);expect(envelope.errorCode).toBe('body_read_failed');expect(envelope.bodyBytes).toBe(0);
 });
 it('rejects manipulated byte metadata and malformed choices without exposing provider text',async()=>{
  const envelope=await captureHttpEnvelope(Response.json({choices:[{message:{content:{secret:'private'}}}]}),meta);expect(()=>completionFromEnvelope(envelope)).toThrow('invalid_output');expect(()=>completionFromEnvelope({...envelope,bodyBytes:1})).toThrow('invalid_output');
 });
});

describe('safe derived metadata',()=>{
 it.each([{model:'private body with spaces'}, {usage:{prompt_tokens:'private body'}}, {usage:{completion_tokens:-1}}])('rejects unsafe model/usage metadata %j',async extra=>{
  const envelope=await captureHttpEnvelope(Response.json({...extra,choices:[{message:{content:'{"n":1}'}}]}),meta);expect(()=>completionFromEnvelope(envelope)).toThrow('invalid_output');
 });
});


describe('durable envelope metadata validation',()=>{
 it.each([{version:2},{bodyComplete:'true'},{bodyBase64:null},{bodyBytes:-1},{bodyBytes:HTTP_RECEIPT_MAX_BODY_BYTES+1},{status:199},{status:500},{attempts:0},{attempts:1.5},{fallback:'false'},{latencyMs:-1},{latencyMs:NaN},{model:'private text'},{errorCode:'raw private message'},{errorCode:'body_read_failed'},{contentType:'text/html'}])('rejects incompatible or unsafe persisted metadata %j',async change=>{
  const envelope=await captureHttpEnvelope(Response.json({choices:[{message:{content:'{"n":1}'}}]}),meta);expect(()=>completionFromEnvelope({...envelope,...change} as HttpCompletionEnvelope)).toThrow('envelope_metadata_invalid');
 });
});
