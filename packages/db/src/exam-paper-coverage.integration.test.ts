import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {describe,expect,it} from 'vitest';
const target=process.env.TEST_DATABASE_URL,enabled=process.env.G29_PAPER_SQL_TESTS==='1'&&!!target;
if(enabled&&(!/^remoa_g29_test_/.test(new URL(target!).pathname.slice(1))||!['127.0.0.1','localhost'].includes(new URL(target!).hostname)))throw Error('G29 paper tests require disposable local remoa_g29_test database');
describe.skipIf(!enabled)('G29 paper coverage SQL',()=>{
 it('defaults legacy completeness to unknown and rejects invented completeness or unbacked source excerpts',async()=>{
  const db=postgres(target!,{max:1,onnotice:()=>{}});
  try{await db.begin(async tx=>{
   const [source]=await tx`insert into public.question_sources(name,publisher,url)values('Synthetic','Synthetic','https://example.test')returning id`;
   const id=randomUUID();
   const [paper]=await tx`insert into public.exam_papers(id,source_id,name,institution,year,edition,booklet)values(${id},${source!.id},'Synthetic paper','Synthetic',2024,'2024','')returning coverage_kind,expected_question_count`;
   expect(paper).toEqual({coverage_kind:'unknown',expected_question_count:null});
   await expect(tx.savepoint(sp=>sp`update public.exam_papers set coverage_kind='complete' where id=${id}`)).rejects.toThrow('exam_papers_complete_evidence_chk');
   await expect(tx.savepoint(sp=>sp`update public.exam_papers set expected_question_count=-1 where id=${id}`)).rejects.toThrow('exam_papers_expected_count_chk');
   await expect(tx.savepoint(sp=>sp`update public.exam_papers set coverage_kind='source_excerpt' where id=${id}`)).rejects.toThrow('source_excerpt_create_fresh');
   await expect(tx.savepoint(sp=>sp`insert into public.exam_papers(source_id,name,institution,year,edition,booklet,status,coverage_kind)values(${source!.id},'Fake excerpt','Synthetic',2024,'2024','','published','source_excerpt')`)).rejects.toThrow('source_excerpt_stage_first');
   await expect(tx.savepoint(sp=>sp`insert into public.exam_papers(source_id,name,institution,year,edition,booklet,coverage_kind)values(${source!.id},'Fake excerpt','Synthetic',2024,'2024','','source_excerpt')`)).rejects.toThrow('source_excerpt_membership_required');
   expect((await tx`select has_table_privilege('authenticated','public.exam_papers','SELECT')as paper,has_table_privilege('authenticated','public.question_documents','SELECT')as documents`)[0]).toEqual({paper:false,documents:false});
   throw Error('fixture_rollback');
  }).catch(e=>{if(!(e instanceof Error)||e.message!=='fixture_rollback')throw e;});}finally{await db.end();}
 });
});
