/** Pending live gate: no default DATABASE_URL, Docker restart, shared/prod connection or implicit migration.
 * Runner must explicitly supply TEST_DATABASE_URL to a disposable f33_test database with0049 applied.
 */
import {eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const postgres=createRequire(new URL('../../../../../packages/db/package.json',import.meta.url))('postgres') as (url:string,options:{max:number})=>typeof import('@remoa/db').db.$client;
import {drizzle} from 'drizzle-orm/postgres-js';
import type {Tx} from '@remoa/db';
import * as schema from '../../../../../packages/db/src/schema';
vi.mock('../../db',()=>({dbm:async()=>await import('../../../../../packages/db/src/schema')}));
import {createMissingCandidate,orderDraftOccurrences,recoveryState,resolveImportContext} from './recovery';
const target=process.env.TEST_DATABASE_URL;
if(target && (!/^remoa_f33_test(?:_|$)/.test(new URL(target).pathname.slice(1)) || !['127.0.0.1','localhost'].includes(new URL(target).hostname)))throw Error('Recovery integration requires an explicit disposable local remoa_f33_test database');
describe.skipIf(!target)('CCR130 SQL recovery (0049 required; infrastructure pending)',()=>{
 async function fixture(run:(tx:Tx,ids:{importId:string;documentId:string;paperId:string;sourceId:string})=>Promise<void>){
  const client=postgres(target!,{max:1});const db=drizzle(client,{schema});const importId=randomUUID(),source=randomUUID(),documentId=randomUUID(),paperId=randomUUID();
  try{await db.transaction(async tx=>{
   await tx.insert(schema.questionSourcesCatalog).values({id:source,name:'Synthetic recovery',publisher:'Engineering fixture',url:'https://example.org',rightsStatus:'pending'});
   await tx.insert(schema.questionDocuments).values({id:documentId,sourceId:source,kind:'exam',objectKey:`questions/documents/${documentId}.pdf`,sha256:'a'.repeat(64),bytes:100,pages:5});
   await tx.insert(schema.examPapers).values({id:paperId,sourceId:source,documentId,name:'Synthetic recovery',institution:'Engineering',year:2026,edition:importId,booklet:'A'});
   await tx.insert(schema.questionImports).values({id:importId,sourceId:source,paperId,documentId,idempotencyKey:importId,parserVersion:'f33-layout-v4',status:'review'});
   await run(tx as unknown as Tx,{importId,documentId,paperId,sourceId:source});
   throw Error('synthetic_fixture_rollback');
  }).catch(error=>{if(!(error instanceof Error) || error.message!=='synthetic_fixture_rollback')throw error;});}finally{await client.end({timeout:1});}
 }
 it('creates missing Q2 with technical ordinal3 and ranks draft occurrences numerically under paper lock',async()=>fixture(async(tx,ids)=>{
  const candidateIds=[randomUUID(),randomUUID(),randomUUID()],numbers=['1','3','2'];
  for(const[index,number]of numbers.entries()){
   const result=await createMissingCandidate(tx,ids.importId,{candidateId:candidateIds[index]!,importRevision:index,originalNumber:number,markerProvenance:{documentId:ids.documentId,page:1,bbox:[0,0,0.1,0.1]},ownStem:'Synthetic question '+number,alternatives:[{key:'A',text:'First'},{key:'B',text:'Second'}],provenance:[{documentId:ids.documentId,page:1,bbox:[0,0.1,0.5,0.5]}],reason:'Synthetic manually verified marker'});
   expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);
   const qid=randomUUID();await tx.insert(schema.questionBank).values({id:qid,userId:null,sourceId:ids.sourceId,type:'objective',difficulty:'medium',stem:'Synthetic question '+number,alternatives:[{key:'A',text:'First'},{key:'B',text:'Second'}],correctKey:'A',expectedAnswer:'',source:'student',origin:'official_exam',visibility:'public'});
   await tx.insert(schema.examQuestionOccurrences).values({paperId:ids.paperId,questionId:qid,ordinal:result.data.candidate!.ordinal,originalNumber:number});
  }
  const loaded=await recoveryState(tx,ids.importId,3);expect(loaded.ok).toBe(true);if(!loaded.ok)throw Error(loaded.error.message);
  expect((await orderDraftOccurrences(tx,loaded.data)).ok).toBe(true);
  const occurrences=await tx.select().from(schema.examQuestionOccurrences).where(eq(schema.examQuestionOccurrences.paperId,ids.paperId)).orderBy(schema.examQuestionOccurrences.ordinal);expect(occurrences.map(o=>[o.originalNumber,o.ordinal])).toEqual([['1',1],['2',2],['3',3]]);
 }));
 it('rejects a stale context without writes and resolves non-question with durable reason',async()=>fixture(async(tx,ids)=>{
  const contextId=randomUUID(),evidenceHash='b'.repeat(64);await tx.insert(schema.questionImportContexts).values({id:contextId,importId:ids.importId,documentId:ids.documentId,evidenceHash,evidenceObjectKey:`questions/imports/${ids.importId}/contexts/${contextId}.json`,originalText:'Synthetic instructions',declaredNumbers:[],provenance:[{documentId:ids.documentId,page:1,bbox:[0,0,1,0.1]}]});
  const input={importRevision:0,revision:0,evidenceHash,decision:'non_question' as const,targetNumbers:[],text:'',imageRefIds:[],reason:'Synthetic instruction explicitly reviewed'};
  expect((await resolveImportContext(tx,ids.importId,contextId,{...input,revision:1})).ok).toBe(false);
  const result=await resolveImportContext(tx,ids.importId,contextId,input);expect(result.ok).toBe(true);if(result.ok)expect(result.data.context?.resolution).toMatchObject({decision:'non_question',reason:input.reason});
 }));
});
