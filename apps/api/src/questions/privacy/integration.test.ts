import { randomUUID as uuid } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
const objects=vi.hoisted(()=>new Map<string,Buffer>());
const deleted=vi.hoisted(()=>[] as string[]);
const failure=vi.hoisted(()=>({prefix:''}));
vi.mock('../../storage/storage',()=>({headObject:async(k:string)=>objects.has(k)?{size:1,mime:'application/json'}:null,presignGet:async(k:string)=>'https://private.example/'+k+'?signed=private',deletePrefix:async(p:string)=>{deleted.push(p);if(p===failure.prefix)throw Error('synthetic storage outage');for(const k of objects.keys())if(k.startsWith(p))objects.delete(k);}}));
import { exportAccount } from '../../account/account';
import { purgeDeletedAccounts } from '../../account/jobs';
import { isOwnedRawKey } from './export';
const url=process.env.DATABASE_URL;if(url&&!new URL(url).pathname.includes('f33_test'))throw Error('isolated f33_test required');
describe.skipIf(!url)('F33 personal export and purge',()=>{
 let db:typeof import('@remoa/db').db.$client;
 const owner=uuid(),other=uuid(),q=uuid(),qOther=uuid(),run=uuid(),session=uuid(),item=uuid(),source=uuid(),document=uuid(),institutional=uuid(),review=uuid();
 const key=`questions/generation/${owner}/${run}/receipt.json`;
 beforeAll(async()=>{
  db=(await import('@remoa/db')).db.$client;
  for(const id of [owner,other])await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@privacy.example'})`;
  for(const [id,u] of [[q,owner],[qOther,other]])await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source) VALUES(${id!},${u!},'objective','medium','Synthetic personal question','[{"key":"A","text":"Own A"},{"key":"B","text":"Own B"}]','A','Own A','ai')`;
  await db`INSERT INTO question_generation_runs(id,user_id,producer,request_key,prompt_id,prompt_version,model,provider,payload_object_key,status,received_count) VALUES(${run},${owner},'synthetic','privacy','prompt','v1','model','provider',${key},'received',1)`;
  await db`INSERT INTO question_generation_candidates(run_id,ordinal,payload_object_key,state,question_id) VALUES(${run},0,${key},'accepted',${q})`;
  objects.set(key,Buffer.from('personal receipt'));
  await db`INSERT INTO question_sessions(id,user_id,mode,config,status,idempotency_key,report) VALUES(${session},${owner},'simulation','{}','active','privacy','{"score":1,"correct":1,"incorrect":0,"unanswered":0,"annulled":0,"denominator":1}')`;
  await db`INSERT INTO question_session_items(id,user_id,session_id,question_id,position,payload_public,reference_snapshot,shuffle_map,selected_key,answered) VALUES(${item},${owner},${session},${q},0,'{}','{"correctKey":"A","explanation":"SECRET_REFERENCE"}','{"B":"A"}','B',true)`;
  await db`INSERT INTO question_answers(user_id,session_id,item_id,mutation_id,selected_key,correct,elapsed_ms,revision) VALUES(${owner},${session},${item},${uuid()},'B',false,125,1)`;
  await db`INSERT INTO question_user_state(user_id,question_id,annotation,favorite) VALUES(${owner},${q},'Personal note',true)`;
  await db`INSERT INTO question_reports(user_id,question_id,version,type,description) VALUES(${owner},${q},1,'key','Personal issue')`;
  await db`INSERT INTO question_sources(id,name,publisher,url) VALUES(${source},'Synthetic institutional','Synthetic','https://example.org')`;
  await db`INSERT INTO question_documents(id,source_id,user_id,kind,object_key,sha256,bytes,pages) VALUES(${document},${source},${owner},'exam',${'questions/documents/'+owner+'/retained.pdf'},${'a'.repeat(64)},10,1)`;
  await db`INSERT INTO question_bank(id,user_id,visibility,origin,source_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source) VALUES(${institutional},null,'public','official_exam',${source},'objective','medium','Synthetic institutional','[{"key":"A","text":"Institutional A"},{"key":"B","text":"Institutional B"}]','A','A','ai')`;
  await db`UPDATE question_bank SET content_hash=${'b'.repeat(64)} WHERE id=${institutional}`;
  await db`UPDATE profiles SET role='reviewer',name='Synthetic physician',crm='12345-SP' WHERE user_id=${owner}`;
  await db`INSERT INTO question_editorial_reviews(id,question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${review},${institutional},${owner},'Synthetic physician','12345-SP',${'b'.repeat(64)},'approved','Synthetic review record','2026-10-08')`;
  objects.set(`questions/documents/${owner}/retained.pdf`,Buffer.from('institutional'));
 });
 afterAll(async()=>{
  await db`DELETE FROM question_session_items WHERE user_id IN (${owner},${other})`;
  await db`DELETE FROM question_generation_runs WHERE user_id IN (${owner},${other})`;
  await db`DELETE FROM question_bank WHERE id IN (${q},${qOther},${institutional})`;
  await db`DELETE FROM question_documents WHERE id=${document}`;await db`DELETE FROM question_sources WHERE id=${source}`;
  await db`DELETE FROM auth.users WHERE id IN (${owner},${other})`;await db.end({timeout:1});
 });
 it('exports only owned private data; active simulation choices/times without secret snapshots',async()=>{
  const result=await exportAccount(owner);expect(result.ok).toBe(true);if(!result.ok)return;
  const data=result.data.questions;
  expect(data.ownedQuestions.map(r=>r.id)).toEqual([q]);expect(data.ownedQuestions[0]?.correctKey).toBe('A');
  expect(data.generationReceipts[0]?.rawDownload?.url).toContain(key);expect(data.generationReceipts[0]?.candidates[0]?.rawDownload?.url).toContain(key);
  expect(data.answers[0]).toMatchObject({selectedKey:'B',elapsedMs:125});expect(data.userStates[0]?.annotation).toBe('Personal note');expect(data.reports[0]?.description).toBe('Personal issue');
  const sessionData=JSON.stringify({sessions:data.sessions,answers:data.answers});expect(sessionData).not.toMatch(/SECRET_REFERENCE|correctKey|shuffleMap|referenceSnapshot|"score"|"correct"/);
  const b=await exportAccount(other);if(!b.ok)throw Error('export failed');expect(b.data.questions.ownedQuestions.map(r=>r.id)).toEqual([qOther]);expect(b.data.questions.generationReceipts).toEqual([]);expect(b.data.questions.sessions).toEqual([]);expect(b.data.questions.reports).toEqual([]);
 });
 it('storage missing or foreign namespace fails explicitly, never produces a fabricated empty receipt',async()=>{
  objects.delete(key);await expect(exportAccount(owner)).rejects.toThrow('question_export_raw_missing');objects.set(key,Buffer.alloc(1));
  await db`UPDATE question_generation_runs SET payload_object_key=${`questions/generation/${other}/${run}/receipt.json`} WHERE id=${run}`;
  await expect(exportAccount(owner)).rejects.toThrow('question_export_raw_owner_mismatch');await db`UPDATE question_generation_runs SET payload_object_key=${key} WHERE id=${run}`;
  expect(isOwnedRawKey(owner,run,key)).toBe(true);for(const k of [key.replace('receipt','../receipt'),key.replace(owner,other),`questions/imports/${owner}/${run}/file`])expect(isOwnedRawKey(owner,run,k)).toBe(false);
 });
 it('known provider failure without persisted completion exports metadata and null download, never masks a received missing raw',async()=>{
  const failed=uuid(),failureKey=`questions/generation/${owner}/${failed}/receipt.json`;
  await db`INSERT INTO question_generation_runs(id,user_id,producer,request_key,prompt_id,prompt_version,model,provider,payload_object_key,status,error_code) VALUES(${failed},${owner},'synthetic','known-failure','prompt','v1','model','provider',${failureKey},'provider_failed','provider_http_500')`;
  try{const result=await exportAccount(owner);if(!result.ok)throw Error('export failed');expect(result.data.questions.generationReceipts.find(r=>r.id===failed)).toMatchObject({status:'provider_failed',errorCode:'provider_http_500',rawDownload:null});
   await db`UPDATE question_generation_runs SET payload_hash=${'a'.repeat(64)} WHERE id=${failed}`;await expect(exportAccount(owner)).rejects.toThrow('question_export_raw_missing');
  }finally{await db`DELETE FROM question_generation_runs WHERE id=${failed}`;}
 });
 it('finished simulation export still omits institutional reference and report fields',async()=>{
  await db`UPDATE question_sessions SET status='finished',finished_at=now() WHERE id=${session}`;
  const result=await exportAccount(owner);if(!result.ok)throw Error('export failed');expect(result.data.questions.sessions[0]?.status).toBe('finished');expect(result.data.questions.sessions[0]?.result).toMatchObject({score:1,correct:1});expect(JSON.stringify(result.data.questions.sessions)).not.toMatch(/SECRET_REFERENCE|correctKey|shuffle|reference/);
 });
 it('hard deletion cascades personal data and files, preserves institutional document/ownerless question; replay safe',async()=>{
  await db`UPDATE profiles SET deleted_at=now()-interval '8 days' WHERE user_id=${owner}`;
  await purgeDeletedAccounts(new Date());
  expect((await db`SELECT id FROM auth.users WHERE id=${owner}`)).toHaveLength(0);
  for(const table of ['question_bank','question_generation_runs','question_sessions','question_answers','question_user_state','question_reports'])expect((await db.unsafe(`SELECT 1 FROM ${table} WHERE user_id=$1`,[owner]))).toHaveLength(0);
  expect(objects.has(key)).toBe(false);expect(objects.has(`questions/documents/${owner}/retained.pdf`)).toBe(true);
  const [signature]=await db`SELECT user_id,reviewer_name,reviewer_crm,decision FROM question_editorial_reviews WHERE id=${review}`;expect(signature).toMatchObject({user_id:null,reviewer_name:'Synthetic physician',reviewer_crm:'12345-SP',decision:'approved'});
  const [doc]=await db`SELECT user_id FROM question_documents WHERE id=${document}`;expect(doc?.user_id).toBeNull();expect(await db`SELECT id FROM question_bank WHERE id=${institutional}`).toHaveLength(1);
  expect(deleted).toContain(`questions/generation/${owner}/`);expect(deleted.some(p=>p.startsWith('questions/documents/')||p.startsWith('questions/imports/'))).toBe(false);
  const n=deleted.length;await purgeDeletedAccounts(new Date());expect(deleted).toHaveLength(n);expect(await db`SELECT id FROM auth.users WHERE id=${other}`).toHaveLength(1);
 });
 it('storage failure does not block legal deletion and leaves exact personal namespace for operator recovery',async()=>{
  const id=uuid(),orphan=`questions/generation/${id}/${uuid()}/receipt.json`;
  await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@privacy.example'})`;
  await db`UPDATE profiles SET deleted_at=now()-interval '8 days' WHERE user_id=${id}`;
  objects.set(orphan,Buffer.from('orphan'));failure.prefix=`questions/generation/${id}/`;
  try{await purgeDeletedAccounts(new Date());expect(await db`SELECT id FROM auth.users WHERE id=${id}`).toHaveLength(0);expect(objects.has(orphan)).toBe(true);expect(deleted).toContain(failure.prefix);}
  finally{failure.prefix='';objects.delete(orphan);await db`DELETE FROM auth.users WHERE id=${id}`;}
 });

});
