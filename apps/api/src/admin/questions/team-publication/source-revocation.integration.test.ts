/** Route business regression on a disposable DB; auth middleware is replaced only for this isolated fixture. */
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@remoa/db';
import type { AdminEnv } from '../../core';
const context=vi.hoisted(()=>({tx:null as Tx|null,audit:{before:vi.fn(),after:vi.fn()}}));
vi.mock('../../core',async importOriginal=>({...await importOriginal<typeof import('../../core')>(),withAdmin:async(_c:unknown,_action:unknown,_opts:unknown,fn:(tx:Tx,audit:typeof context.audit)=>Promise<unknown>)=>{if(!context.tx)throw Error('test_transaction_required');return fn(context.tx,context.audit);}}));
vi.mock('../../../cache',()=>({invalidate:vi.fn()}));
const url=process.env.DATABASE_URL,enabled=process.env.G29_CATALOG_SQL_TEST==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/remoa_g29_full_test_20261019')throw Error('disposable_full_corpus_required');}
describe.skipIf(!enabled)('signed source revocation route',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('permits revocation/restriction without editing questions and refuses generic approval with409',async()=>{
  const {db,questionSourcesCatalog}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});
  const {questionAdminRoutes}=await import('../routes');
  const {teamReadable}=await import('../../../questions/catalog/service');
  try{await db.transaction(async tx=>{
   context.tx=tx;
   const [source]=await tx.select().from(questionSourcesCatalog).limit(1);expect(source).toBeTruthy();
   const [before]=await tx.execute<{fingerprint:string}>(sql`SELECT md5(string_agg(id::text||content_hash||coalesce(reviewed_hash,'')||rights_status||availability||catalog_status,'' ORDER BY id)) fingerprint FROM question_bank WHERE source_id=${source!.id}`);
   const app=new Hono<AdminEnv>().route('/',questionAdminRoutes);
   const patch=async(rightsStatus:string)=>{
    const res=await app.request('/sources/'+source!.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:source!.name,publisher:source!.publisher,url:source!.url,rightsStatus,rightsEvidence:'Aprovado por Remoa',rightsScope:'g29-cp21-20261019',rightsExpiresAt:'2030-11-19T23:59:59.000Z',reason:'Synthetic source state mutation'})});
    return res.status;
   };
   for(const status of ['revoked','restricted']){
    expect(await patch(status)).toBe(200);
    const [visible]=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM question_bank q WHERE q.source_id=${source!.id} AND ${teamReadable}`);expect(visible?.n).toBe(0);
   }
   expect(await patch('authorized')).toBe(409);
   const [after]=await tx.execute<{fingerprint:string}>(sql`SELECT md5(string_agg(id::text||content_hash||coalesce(reviewed_hash,'')||rights_status||availability||catalog_status,'' ORDER BY id)) fingerprint FROM question_bank WHERE source_id=${source!.id}`);expect(after?.fingerprint).toBe(before?.fingerprint);
   expect(context.audit.after.mock.calls.at(-1)![0]).toMatchObject({teamSource:true,questionSignaturesPreserved:true});
   throw Error('synthetic_fixture_rollback');
  });}catch(e){if(!(e instanceof Error)||e.message!=='synthetic_fixture_rollback')throw e;}finally{context.tx=null;}
 },120000);
});
