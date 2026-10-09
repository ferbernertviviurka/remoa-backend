import { AsyncLocalStorage } from 'node:async_hooks';
import type { HttpCompletionEnvelope } from './http-envelope';
import type { Completion } from './client';
/** Infrastructure callback only: the AI package neither imports the database nor knows a user. */
export type CompletionReceiptCall = { fn: string; index: number; repaired: boolean };
export type CompletionReceiptHooks = {
  load(call: CompletionReceiptCall): Promise<Completion | null>;
  saveEnvelope?(call: CompletionReceiptCall, envelope: HttpCompletionEnvelope): Promise<void>;
  save(call: CompletionReceiptCall, completion: Completion): Promise<void>;
  /** Only an explicit HTTP refusal/local limit establishes that no completion was returned. */
  failed?(call:CompletionReceiptCall,failure:{code:string;knownNoCompletion:boolean}):Promise<void>;
};
export class ReceiptPersistenceError extends Error {
  constructor(readonly reason: string) { super('question_receipt_persistence_failed'); this.name='ReceiptPersistenceError'; }
}
const scopes=new AsyncLocalStorage<{hooks:CompletionReceiptHooks;next:number}>();
export const withCompletionReceipts=<T>(hooks:CompletionReceiptHooks,fn:()=>Promise<T>)=>scopes.run({hooks,next:0},fn);
export const hasCompletionReceiptScope=(fn:string)=>Boolean(scopes.getStore())&&['generate','extract','summary'].includes(fn);
export function nextCompletionReceipt(fn:string,repaired:boolean){
  const scope=scopes.getStore();if(!scope || !['generate','extract','summary'].includes(fn))return null;
  return {hooks:scope.hooks,call:{fn,index:scope.next++,repaired}};
}
