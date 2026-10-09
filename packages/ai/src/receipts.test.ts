import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { z } from 'zod';
import { generateJson,resetUsage,type Completion } from './client';
import { withCompletionReceipts,ReceiptPersistenceError,type CompletionReceiptCall } from './receipts';
const original={...process.env};
beforeEach(()=>{resetUsage();process.env.OPENROUTER_API_KEY='synthetic';process.env.AI_MODEL='test/model';process.env.AI_MODEL_FALLBACKS='';process.env.AI_REQUIRE_FREE='false';process.env.AI_MAX_RETRIES='0';});
afterEach(()=>{process.env={...original};});
const response=(text:string)=>Response.json({model:'test/model',choices:[{message:{content:text}}]});
describe('provider receipt before schema transform',()=>{
  it('awaits original and repair including invalid JSON, before destructive transforms',async()=>{
    const saved:{call:CompletionReceiptCall;done:Completion}[]=[];const replies=['not json','{"cards":[{"question":"one"},{"question":"two"}]}'];
    const fetchImpl=vi.fn(async()=>response(replies.shift()!));
    const schema=z.object({cards:z.array(z.object({question:z.string()}))}).transform(()=>({cards:[]}));
    const result=await withCompletionReceipts({load:async()=>null,save:async(call,done)=>{saved.push({call,done});}},()=>generateJson(schema,{fn:'extract',system:'synthetic',user:'synthetic',fetchImpl}));
    expect(result.data.cards).toEqual([]);expect(saved.map(s=>s.call.repaired)).toEqual([false,true]);expect(saved[0]!.done.text).toBe('not json');expect(JSON.parse(saved[1]!.done.text).cards).toHaveLength(2);
  });
  it('receipt failure stops success and prevents repair/provider retry',async()=>{
    const fetchImpl=vi.fn(async()=>response('bad json'));
    await expect(withCompletionReceipts({load:async()=>null,save:async()=>{throw Error('storage down');}},()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl}))).rejects.toBeInstanceOf(ReceiptPersistenceError);expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('records explicit provider refusal as terminal, transport uncertainty as pending',async()=>{
    const failed=vi.fn();const hooks={load:async()=>null,save:vi.fn(),failed};
    await expect(withCompletionReceipts(hooks,()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl:async()=>new Response('down',{status:503})}))).rejects.toThrow();
    expect(failed.mock.calls[0]![1]).toMatchObject({knownNoCompletion:true});
    await expect(withCompletionReceipts(hooks,()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl:async()=>{throw Error('connection lost');}}))).rejects.toThrow();
    expect(failed.mock.calls[1]![1]).toMatchObject({knownNoCompletion:false});expect(hooks.save).not.toHaveBeenCalled();
  });
  it.each([408,504])('HTTP %i gateway timeout remains uncertain',async status=>{
    const failed=vi.fn();await expect(withCompletionReceipts({load:async()=>null,save:vi.fn(),failed},()=>generateJson(z.object({n:z.number()}),{fn:'extract',system:'s',user:'u',fetchImpl:async()=>new Response('gateway timeout',{status})}))).rejects.toThrow();
    expect(failed.mock.calls[0]![1]).toMatchObject({code:'timeout',knownNoCompletion:false});
  });
  it.each(['network','timeout'] as const)('uncertain %s stops internal retries and fallback under receipts',async kind=>{
    process.env.AI_MAX_RETRIES='2';process.env.AI_MODEL_FALLBACKS='test/fallback';
    const fetchImpl=vi.fn(async()=>{if(kind==='network')throw Error('lost response');return new Response('gateway timeout',{status:504});});
    const failed=vi.fn();await expect(withCompletionReceipts({load:async()=>null,save:vi.fn(),failed},()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl,sleep:async()=>{}}))).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);expect(failed.mock.calls[0]![1]).toMatchObject({knownNoCompletion:false});
  });
  it('fails closed if the provider failure cannot be recorded',async()=>{
    await expect(withCompletionReceipts({load:async()=>null,save:vi.fn(),failed:async()=>{throw Error('db down');}},()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl:async()=>new Response('down',{status:503})}))).rejects.toBeInstanceOf(ReceiptPersistenceError);
  });
  it('replays durable completion without making a provider request',async()=>{
    const fetchImpl=vi.fn();const done:Completion={text:'{"n":1}',model:'test/model',tokensIn:1,tokensOut:1,latencyMs:1,attempts:1,fallback:false,billable:true};
    const save=vi.fn();const result=await withCompletionReceipts({load:async()=>done,save},()=>generateJson(z.object({n:z.number()}),{fn:'summary',system:'s',user:'u',fetchImpl}));expect(result.data.n).toBe(1);expect(fetchImpl).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  });
  it('does not record grading or classification and isolates concurrent producer scopes',async()=>{
    const a=vi.fn(),b=vi.fn();const fetchImpl=vi.fn(async()=>response('{"n":1}'));
    await Promise.all([withCompletionReceipts({load:async()=>null,save:a},()=>generateJson(z.object({n:z.number()}),{fn:'generate',system:'s',user:'u',fetchImpl})),withCompletionReceipts({load:async()=>null,save:b},()=>generateJson(z.object({n:z.number()}),{fn:'summary',system:'s',user:'u',fetchImpl}))]);
    expect(a).toHaveBeenCalledTimes(1);expect(b).toHaveBeenCalledTimes(1);expect(a.mock.calls[0]![0].index).toBe(0);expect(b.mock.calls[0]![0].index).toBe(0);
    await withCompletionReceipts({load:async()=>null,save:a},()=>generateJson(z.object({n:z.number()}),{fn:'grader',system:'s',user:'u',fetchImpl}));expect(a).toHaveBeenCalledTimes(1);
  });
});
