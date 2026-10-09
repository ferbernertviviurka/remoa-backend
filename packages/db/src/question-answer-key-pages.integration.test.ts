/** Pending isolated SQL gate: opt-in only after0051 is explicitly applied to a disposable test database.
 * This test never migrates or uses default DATABASE_URL. Source-only task intentionally leaves it skipped.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
const target=process.env.TEST_DATABASE_URL;
const enabled=process.env.F33_ANSWER_KEY_PAGES_SQL_TESTS==='1' && !!target;
if(enabled && (!/^remoa_f33_test(?:_|$)/.test(new URL(target!).pathname.slice(1)) || !['127.0.0.1','localhost'].includes(new URL(target!).hostname)))throw Error('CCR133 requires disposable local remoa_f33_test database');
describe.skipIf(!enabled)('CCR133 live SQL selector (pending infrastructure/migration)',()=>{
 async function fixture(run:(tx:postgres.TransactionSql,ids:{source:string;exam:string;key:string;otherKey:string;job:string})=>Promise<void>){
  const sql=postgres(target!,{max:1}),ids={source:randomUUID(),exam:randomUUID(),key:randomUUID(),otherKey:randomUUID(),job:randomUUID()};
  try{await sql.begin(async tx=>{
   await tx`INSERT INTO public.question_sources(id,name,publisher,url) VALUES(${ids.source},'Synthetic pages','Engineering','https://example.org')`;
   for(const [id,kind]of [[ids.exam,'exam'],[ids.key,'answer_key'],[ids.otherKey,'answer_key']])await tx`INSERT INTO public.question_documents(id,source_id,kind,object_key,sha256,bytes,pages) VALUES(${id!},${ids.source},${kind!},${'questions/documents/'+id+'.pdf'},${'a'.repeat(64)},100,5)`;
   await run(tx,ids);throw Error('synthetic_fixture_rollback');
  }).catch(error=>{if(!(error instanceof Error) || error.message!=='synthetic_fixture_rollback')throw error;});}finally{await sql.end({timeout:1});}
 }
 it('rejects invalid SQL arrays including multidimensional/nonstandard bounds and preserves null',async()=>fixture(async tx=>{
  const valid=await tx`SELECT public.f33_valid_answer_key_pages(ARRAY[1,3,5]) AS valid,public.f33_valid_answer_key_pages(ARRAY[1,1]) AS duplicate,public.f33_valid_answer_key_pages(ARRAY[3,1]) AS unordered,public.f33_valid_answer_key_pages(ARRAY[NULL]::integer[]) AS missing,public.f33_valid_answer_key_pages(ARRAY[]::integer[]) AS empty,public.f33_valid_answer_key_pages(ARRAY[501]) AS overflow,public.f33_valid_answer_key_pages(ARRAY[[1,2],[3,4]]) AS matrix,public.f33_valid_answer_key_pages('[0:1]={1,2}'::integer[]) AS lowerbound`;
  expect(valid[0]).toEqual({valid:true,duplicate:false,unordered:false,missing:false,empty:false,overflow:false,matrix:false,lowerbound:false});
 }));
 it('accepts selected original page3 and unrelated job-state updates',async()=>fixture(async(tx,id)=>{
  await tx`INSERT INTO public.question_imports(id,source_id,document_id,answer_key_document_id,answer_key_pages,idempotency_key,parser_version) VALUES(${id.job},${id.source},${id.exam},${id.key},ARRAY[3],${id.job},'f33-layout-v5')`;
  await tx`UPDATE public.question_imports SET status='review',revision=revision+1 WHERE id=${id.job}`;
  expect((await tx`SELECT answer_key_pages FROM public.question_imports WHERE id=${id.job}`)[0]?.answer_key_pages).toEqual([3]);
 }));
 it('rejects a selected page beyond the actual document before committing',async()=>{
  await expect(fixture(async(tx,id)=>{await tx`INSERT INTO public.question_imports(id,source_id,document_id,answer_key_document_id,answer_key_pages,idempotency_key,parser_version) VALUES(${id.job},${id.source},${id.exam},${id.key},ARRAY[6],${id.job},'f33-layout-v5')`;})).rejects.toThrow('answer_key_pages_out_of_document');
 });
 it.each(['pages','document','legacy'])('blocks %s mutation without rewriting history',async mode=>{
  await expect(fixture(async(tx,id)=>{
   await tx`INSERT INTO public.question_imports(id,source_id,document_id,answer_key_document_id,answer_key_pages,idempotency_key,parser_version) VALUES(${id.job},${id.source},${id.exam},${id.key},${mode==='legacy'?null:tx.array([3])},${id.job},'f33-layout-v5')`;
   if(mode==='document')await tx`UPDATE public.question_imports SET answer_key_document_id=${id.otherKey} WHERE id=${id.job}`;
   else await tx`UPDATE public.question_imports SET answer_key_pages=ARRAY[5] WHERE id=${id.job}`;
  })).rejects.toThrow('answer_key_selection_immutable_create_new_import');
 });
 it('denies direct authenticated selector access (table-level privilege cannot override it)',async()=>fixture(async tx=>{
  expect((await tx`SELECT has_column_privilege('authenticated','public.question_imports','answer_key_pages','SELECT') AS allowed`)[0]?.allowed).toBe(false);
  await expect(tx.savepoint(async sp=>{await sp`SET LOCAL ROLE authenticated`;await sp`SELECT answer_key_pages FROM public.question_imports LIMIT 1`;})).rejects.toThrow();
 }));
});
