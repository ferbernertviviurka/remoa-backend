/** CCR113: synthetic data, isolated Postgres, each fixture rolls back. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,describe,it,expect} from 'vitest';
const url=process.env.DATABASE_URL;if(url&&!new URL(url).pathname.includes('f33_test'))throw Error('isolated F33 database required');
const db=url?postgres(url,{max:1,onnotice:()=>{}}):null;
describe.skipIf(!db)('F33 institutional retention and signing invariants',()=>{
 afterAll(async()=>{await db?.end();});
 async function fixture(test:(tx:postgres.TransactionSql,ids:{admin:string;reviewer:string;owner:string;source:string;question:string;privateQ:string;topic:string;area:string;document:string;importId:string;paper:string})=>Promise<void>){
  const marker=new Error('synthetic rollback');await db!.begin(async tx=>{
   const admin=randomUUID(),reviewer=randomUUID(),owner=randomUUID();for(const id of[admin,reviewer,owner])await tx`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@retention-f33.example'})`;
   await tx`UPDATE profiles SET role='admin' WHERE user_id=${admin}`;await tx`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='CRM/SP 12345' WHERE user_id=${reviewer}`;
   const [source]=await tx`INSERT INTO question_sources(name,publisher,url,rights_status,rights_evidence) VALUES('Synthetic','Synthetic','https://example.org','authorized','Synthetic permission') RETURNING id`;
   const [document]=await tx`INSERT INTO question_documents(user_id,source_id,kind,object_key,sha256,bytes) VALUES(${admin},${source!.id},'exam','synthetic/private.pdf',${'b'.repeat(64)},100) RETURNING id`;
   const [paper]=await tx`INSERT INTO exam_papers(source_id,document_id,name,institution,year,edition,booklet,status,key_final) VALUES(${source!.id},${document!.id},'Synthetic','Synthetic',2026,${randomUUID()},'A','published',true) RETURNING id`;
   const [job]=await tx`INSERT INTO question_imports(user_id,source_id,paper_id,document_id,idempotency_key,parser_version) VALUES(${admin},${source!.id},${paper!.id},${document!.id},${randomUUID()},'test') RETURNING id`;
   const [area]=await tx`INSERT INTO enamed_taxonomy(code,kind,area,name) VALUES(${randomUUID()},'area','CM','Synthetic area') RETURNING id`;
   const [topic]=await tx`INSERT INTO enamed_taxonomy(code,kind,area,name,parent_id) VALUES(${randomUUID()},'topic','CM','Synthetic topic',${area!.id}) RETURNING id`;
   const options=tx.json([{key:'A',text:'Synthetic one'},{key:'B',text:'Synthetic two'}]);const hash='c'.repeat(64);
   const [q]=await tx`INSERT INTO question_bank(type,difficulty,stem,alternatives,correct_key,expected_answer,source,user_id,origin,visibility,source_id,status,rights_status,integrity_confirmed,key_final,enamed_confirmed,enamed_area_id,enamed_topic_id,content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,explanation) VALUES('objective','medium','Synthetic question',${options}::jsonb,'A','Synthetic one','student',NULL,'official_exam','public',${source!.id},'approved','authorized',true,true,true,${area!.id},${topic!.id},${hash},${hash},'Synthetic reviewer','12345-SP','2026-10-08','Synthetic explanation') RETURNING id`;
   const [privateQ]=await tx`INSERT INTO question_bank(type,difficulty,stem,alternatives,correct_key,expected_answer,source,user_id,origin,visibility) VALUES('objective','medium','Synthetic personal question',${options}::jsonb,'A','Synthetic one','student',${owner},'user_authored','private') RETURNING id`;
   await test(tx,{admin,reviewer,owner,source:source!.id,document:document!.id,paper:paper!.id,importId:job!.id,question:q!.id,privateQ:privateQ!.id,topic:topic!.id,area:area!.id});throw marker;
  }).catch(error=>{if(error!==marker)throw error;});
 }
 const sign=(tx:postgres.TransactionSql,ids:{question:string;reviewer:string},date='2026-10-08')=>tx`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${ids.question},${ids.reviewer},'Synthetic reviewer','CRM/SP 12345',${'c'.repeat(64)},'approved','Synthetic review only',${date})`;
 it('deleting uploader and reviewer retains institutional assets and immutable signed approval; private owner cascades',async()=>fixture(async(tx,ids)=>{
  await sign(tx,ids);await tx`UPDATE question_bank SET catalog_status='published' WHERE id=${ids.question}`;
  await tx`UPDATE profiles SET role='student',name='Changed identity',crm=null WHERE user_id=${ids.reviewer}`;
  await tx`UPDATE question_bank SET availability='superseded' WHERE id=${ids.question}`;
  const [session]=await tx`INSERT INTO question_sessions(user_id,mode,config,idempotency_key) VALUES(${ids.owner},'study','{}',${randomUUID()}) RETURNING id`;
  await tx`INSERT INTO question_session_items(user_id,session_id,question_id,position,payload_public,reference_snapshot) VALUES(${ids.owner},${session!.id},${ids.privateQ},0,'{}','{}')`;
  const [run]=await tx`INSERT INTO question_generation_runs(user_id,producer,request_key,prompt_id,prompt_version,model,provider) VALUES(${ids.owner},'challenge_objective',${randomUUID()},'test','test','test','test') RETURNING id`;
  await tx`INSERT INTO question_generation_candidates(run_id,ordinal,payload_object_key,question_id) VALUES(${run!.id},0,'synthetic',${ids.privateQ})`;
  await tx`DELETE FROM auth.users WHERE id IN (${ids.admin},${ids.reviewer},${ids.owner})`;
  await tx`SET CONSTRAINTS ALL IMMEDIATE`;expect((await tx`SELECT id FROM question_generation_runs WHERE user_id=${ids.owner}`).length).toBe(0);expect((await tx`SELECT id FROM question_session_items WHERE user_id=${ids.owner}`).length).toBe(0);
  const [doc]=await tx`SELECT user_id FROM question_documents WHERE id=${ids.document}`;const [job]=await tx`SELECT user_id FROM question_imports WHERE id=${ids.importId}`;const [review]=await tx`SELECT user_id,reviewer_name,reviewer_crm,reference_date FROM question_editorial_reviews WHERE question_id=${ids.question}`;
  expect(doc!.user_id).toBeNull();expect(job!.user_id).toBeNull();expect(review).toMatchObject({user_id:null,reviewer_name:'Synthetic reviewer',reviewer_crm:'12345-SP',reference_date:'2026-10-08'});
  expect((await tx`SELECT id FROM exam_papers WHERE id=${ids.paper}`).length).toBe(1);expect((await tx`SELECT id FROM question_bank WHERE id=${ids.privateQ}`).length).toBe(0);
  await tx`UPDATE question_sources SET rights_status='revoked' WHERE id=${ids.source}`;const [q]=await tx`SELECT catalog_status FROM question_bank WHERE id=${ids.question}`;expect(q!.catalog_status).toBe('withdrawn');
 }));
 it.each(['active','annulled'] as const)('source revocation preserves signed %s and reauthorization requires explicit publication',async availability=>fixture(async(tx,ids)=>{
  await tx`UPDATE question_bank SET availability=${availability},correct_key=${availability==='annulled'?null:'A'} WHERE id=${ids.question}`;await sign(tx,ids);await tx`UPDATE question_bank SET catalog_status='published' WHERE id=${ids.question}`;
  await tx`UPDATE question_sources SET rights_status='revoked' WHERE id=${ids.source}`;
  const [q]=await tx`SELECT catalog_status,rights_status,availability,correct_key,content_hash,reviewed_hash FROM question_bank WHERE id=${ids.question}`;
  expect(q).toMatchObject({catalog_status:'withdrawn',rights_status:'revoked',availability,correct_key:availability==='annulled'?null:'A',content_hash:'c'.repeat(64),reviewed_hash:'c'.repeat(64)});
  await tx`UPDATE question_sources SET rights_status='authorized' WHERE id=${ids.source}`;
  const [after]=await tx`SELECT catalog_status,availability,correct_key FROM question_bank WHERE id=${ids.question}`;expect(after).toMatchObject({catalog_status:'withdrawn',availability,correct_key:availability==='annulled'?null:'A'});
  expect((await tx`SELECT status FROM exam_papers WHERE id=${ids.paper}`)[0]!.status).toBe('withdrawn');
  await tx`UPDATE question_bank SET rights_status='authorized',catalog_status='published' WHERE id=${ids.question}`;expect((await tx`SELECT catalog_status FROM question_bank WHERE id=${ids.question}`)[0]!.catalog_status).toBe('published');
 }));
 it('new signatures require active reviewer, valid CRM, real calendar, exact content hash and remain append-only',async()=>fixture(async(tx,ids)=>{
  await expect(tx.savepoint(sp=>sign(sp,ids,'2026-02-30'))).rejects.toThrow();await tx`UPDATE profiles SET crm='INVALID-000' WHERE user_id=${ids.reviewer}`;await expect(tx.savepoint(sp=>sign(sp,ids))).rejects.toThrow();await tx`UPDATE profiles SET crm='12345-SP',role='admin' WHERE user_id=${ids.reviewer}`;await expect(tx.savepoint(sp=>sign(sp,ids))).rejects.toThrow();await tx`UPDATE profiles SET role='reviewer' WHERE user_id=${ids.reviewer}`;await sign(tx,ids);
  await expect(tx.savepoint(sp=>sp`UPDATE question_editorial_reviews SET reviewer_name='Changed name' WHERE question_id=${ids.question}`)).rejects.toThrow();await expect(tx.savepoint(sp=>sp`DELETE FROM question_editorial_reviews WHERE question_id=${ids.question}`)).rejects.toThrow();
 }));
 it('publication rejects a topic in another area even when its parent points at the selected area',async()=>fixture(async(tx,ids)=>{
  await sign(tx,ids);await tx`UPDATE enamed_taxonomy SET area='GO' WHERE id=${ids.topic}`;await expect(tx.savepoint(sp=>sp`UPDATE question_bank SET catalog_status='published' WHERE id=${ids.question}`)).rejects.toThrow();await tx`UPDATE enamed_taxonomy SET area='CM' WHERE id=${ids.topic}`;await tx`UPDATE question_bank SET catalog_status='published' WHERE id=${ids.question}`;
  await expect(tx.savepoint(sp=>sp`UPDATE question_bank SET difficulty='easy' WHERE id=${ids.question}`)).rejects.toThrow();await expect(tx.savepoint(sp=>sp`UPDATE question_bank SET enamed_topic_id=NULL WHERE id=${ids.question}`)).rejects.toThrow();
 }));
 it.each(['revoked','expired'] as const)('authenticated cannot read frozen payload after source%s, while owner metadata remains isolated',async state=>fixture(async(tx,ids)=>{
  await sign(tx,ids);await tx`UPDATE question_bank SET catalog_status='published' WHERE id=${ids.question}`;
  const [session]=await tx`INSERT INTO question_sessions(user_id,mode,config,idempotency_key) VALUES(${ids.owner},'simulation','{}',${randomUUID()}) RETURNING id`;
  await tx`INSERT INTO question_session_items(user_id,session_id,question_id,position,payload_public,reference_snapshot) VALUES(${ids.owner},${session!.id},${ids.question},0,'{"stem":"Synthetic protected frozen content","assets":[]}','{}')`;
  if(state==='revoked')await tx`UPDATE question_sources SET rights_status='revoked' WHERE id=${ids.source}`;
  else await tx`UPDATE question_sources SET rights_expires_at=now()-interval '1 second' WHERE id=${ids.source}`;
  const [grant]=await tx`SELECT has_column_privilege('authenticated','public.question_session_items','payload_public','SELECT') allowed`;
  expect(grant!.allowed).toBe(false);
  await expect(tx.savepoint(async sp=>{await sp`SELECT set_config('request.jwt.claim.sub',${ids.owner},true)`;await sp`SET LOCAL ROLE authenticated`;await sp`SELECT payload_public FROM question_session_items WHERE session_id=${session!.id}`;})).rejects.toMatchObject({code:'42501'});
  await tx.savepoint(async sp=>{await sp`SELECT set_config('request.jwt.claim.sub',${ids.owner},true)`;await sp`SET LOCAL ROLE authenticated`;expect((await sp`SELECT id,question_id,answered FROM question_session_items WHERE session_id=${session!.id}`).length).toBe(1);await sp`RESET ROLE`;});
  await tx.savepoint(async sp=>{await sp`SELECT set_config('request.jwt.claim.sub',${ids.admin},true)`;await sp`SET LOCAL ROLE authenticated`;expect((await sp`SELECT id FROM question_session_items WHERE session_id=${session!.id}`).length).toBe(0);await sp`RESET ROLE`;});
 }));
 it('deferred links still reject a non-existent question at transaction commit',async()=>{
  const owner=randomUUID();await expect(db!.begin(async tx=>{
   await tx`INSERT INTO auth.users(id,email) VALUES(${owner},${owner+'@retention-f33.example'})`;
   const [run]=await tx`INSERT INTO question_generation_runs(user_id,producer,request_key,prompt_id,prompt_version,model,provider) VALUES(${owner},'challenge_objective',${randomUUID()},'test','test','test','test') RETURNING id`;
   await tx`INSERT INTO question_generation_candidates(run_id,ordinal,payload_object_key,question_id) VALUES(${run!.id},0,'synthetic',${randomUUID()})`;
  })).rejects.toThrow();expect((await db!`SELECT id FROM auth.users WHERE id=${owner}`).length).toBe(0);
 });

});
