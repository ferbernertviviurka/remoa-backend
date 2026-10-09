import { randomUUID as uuid } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { questionSessionPublicSchema,questionSessionReportSchema,questionSessionRecalculationSchema,questionListResultSchema } from '@remoa/contracts';
vi.mock('../../cache',()=>({invalidate:vi.fn(async()=>{})}));
const url=process.env.DATABASE_URL;if(url&&!new URL(url).pathname.includes('f33_test'))throw Error('isolated f33_test required');
describe.skipIf(!url)('CCR116 read-only recalculation and explicit uncertainty',()=>{
 const owner=uuid(),other=uuid(),reviewer=uuid(),source=uuid(),area=uuid(),topic=uuid(),privateQ=uuid(),untouched=uuid(),original=uuid(),versions:string[]=[original];
 const choices=[{key:'A',text:'Synthetic first choice'},{key:'B',text:'Synthetic second choice'}];
 let db:typeof import('@remoa/db').db.$client,app:ReturnType<typeof import('../../app').createApp>,publicSession:string,originalReport:unknown,previous:string=original;
 const call=async(path:string,method='GET',body?:unknown,user=owner,key?:string)=>{const response=await app.request('/v1'+path,{method,headers:{authorization:'Bearer '+user,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:(await response.json() as {data?:unknown}).data};};
 const start=async(ids:string[],mode='simulation',shuffle=true)=>{const r=await call('/question-sessions','POST',{mode,questionIds:ids,count:ids.length,shuffle},owner,uuid());expect(r.status).toBe(200);return questionSessionPublicSchema.parse(r.data);};
 const answer=async(s:string,i:string,selectedKey:string|null,revision=0,mutationId=uuid())=>call(`/question-sessions/${s}/items/${i}/answer`,'PUT',{selectedKey,revision,mutationId,elapsedMs:100});
 async function publishSynthetic(id:string,version=1,key:string|null='A',alts=choices,stem='Synthetic public stem',annulled=false){
  versions.push(...(versions.includes(id)?[]:[id]));const hash=(version%2?'a':'b').repeat(64);
  await db`INSERT INTO question_bank(id,user_id,visibility,origin,source_id,supersedes_id,version,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,status,rights_status,integrity_confirmed,key_final,enamed_confirmed,enamed_area_id,enamed_topic_id,content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,availability) VALUES(${id},null,'public','official_exam',${source},${version===1?null:previous},${version},'objective','medium',${stem},${JSON.stringify(alts)}::jsonb,${key},'Synthetic answer','ai','Synthetic reviewed explanation','approved','authorized',true,true,true,${area},${topic},${hash},${hash},'Synthetic reviewer','12345-SP','2026-10-08',${annulled?'annulled':'active'})`;
  await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${reviewer},'Synthetic reviewer','12345-SP',${hash},'approved','Synthetic test fixture','2026-10-08')`;
  await db`UPDATE question_bank SET catalog_status='published',published_at=now() WHERE id=${id}`;
  if(version>1)await db`UPDATE question_bank SET availability='superseded' WHERE id=${previous} AND availability='active'`;previous=id;
 }
 beforeAll(async()=>{
  db=(await import('@remoa/db')).db.$client;for(const id of [owner,other,reviewer])await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@recalc.example'})`;
  await db`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
  await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'Synthetic source','Synthetic','https://example.org','authorized','Synthetic test permission')`;
  await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic area')`;await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area})`;
  for(const id of [privateQ,untouched])await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source) VALUES(${id},${owner},'objective','medium','Synthetic own stem',${JSON.stringify(choices)}::jsonb,'A','Synthetic own answer','ai')`;
  await publishSynthetic(original);
  const {createApp}=await import('../../app');app=createApp({webOrigin:'http://localhost:3000',verifyToken:async token=>new Set<string>([owner,other]).has(token)?token:null});
 });
 afterAll(async()=>{await db`DELETE FROM question_sessions WHERE user_id IN (${owner},${other})`;await db`DELETE FROM question_bank WHERE source_id=${source} OR user_id IN (${owner},${other})`;await db`DELETE FROM question_sources WHERE id=${source}`;await db`DELETE FROM enamed_taxonomy WHERE id=${topic}`;await db`DELETE FROM enamed_taxonomy WHERE id=${area}`;await db`DELETE FROM auth.users WHERE id IN (${owner},${other},${reviewer})`;await db.end({timeout:1});});
 it('study uncertainty counts as incorrect, untouched item remains unanswered, first response and retries are immutable',async()=>{
  const s=await start([privateQ,untouched],'study',false),item=s.items[0]!,mutation=uuid();expect((await call(`/question-sessions/${s.id}/recalculation`)).status).toBe(409);
  expect((await answer(s.id,item.id,null,0,mutation)).status).toBe(200);expect((await answer(s.id,item.id,null,0,mutation)).status).toBe(200);expect((await answer(s.id,item.id,'A',1)).status).toBe(409);
  const [stored]=await db`SELECT correct FROM question_answers WHERE item_id=${item.id}`;expect(stored!.correct).toBe(false);
  const wrong=questionListResultSchema.parse((await call('/questions?scope=mine&state=wrong')).data);expect(wrong.items.map(q=>q.id)).toContain(privateQ);expect(wrong.items.map(q=>q.id)).not.toContain(untouched);
  const report=questionSessionReportSchema.parse((await call(`/question-sessions/${s.id}/finish`,'POST',{})).data);expect(report).toMatchObject({incorrect:1,unanswered:1,denominator:2,score:0});
  const recalculated=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${s.id}/recalculation`)).data);expect(recalculated.aggregates).toMatchObject({incorrect:1,unanswered:1});expect((await call(`/question-sessions/${s.id}/recalculation`,'GET',undefined,other)).status).toBe(404);
 });
 it('simulation uncertainty is hidden from wrong filter until finish and remains editable; no automatic FSRS',async()=>{
  const s=await start([untouched]),item=s.items[0]!;expect((await answer(s.id,item.id,null)).status).toBe(200);
  expect(questionListResultSchema.parse((await call('/questions?scope=mine&state=wrong')).data).items.map(q=>q.id)).not.toContain(untouched);
  const [raw]=await db`SELECT reference_snapshot FROM question_session_items WHERE id=${item.id}`;const correct=(raw!.reference_snapshot as {correctKey:string}).correctKey;
  expect((await answer(s.id,item.id,correct,1)).status).toBe(200);expect((await call(`/question-sessions/${s.id}/items/${item.id}/reference`)).status).toBe(409);
  const report=questionSessionReportSchema.parse((await call(`/question-sessions/${s.id}/finish`,'POST',{})).data);expect(report.score).toBe(1);
  const [counts]=await db`SELECT (SELECT count(*) FROM attempts WHERE user_id=${owner}) attempts,(SELECT count(*) FROM fsrs_state WHERE user_id=${owner}) schedules`;expect(Number(counts!.attempts)).toBe(0);expect(Number(counts!.schedules)).toBe(0);
 });
 it('maps the displayed shuffled answer by text to a rectified canonical key without changing the original report or event',async()=>{
  const s=await start([original]),item=s.items[0]!;publicSession=s.id;const chosen=item.question.alternatives!.find(a=>a.text===choices[0]!.text)!.key;expect((await answer(s.id,item.id,chosen)).status).toBe(200);
  const finished=await call(`/question-sessions/${s.id}/finish`,'POST',{});expect(questionSessionReportSchema.parse(finished.data).score).toBe(1);const [before]=await db`SELECT report FROM question_sessions WHERE id=${s.id}`;originalReport=before!.report;
  await publishSynthetic(uuid(),2,'A',[{key:'A',text:choices[1]!.text},{key:'B',text:choices[0]!.text}]);
  const result=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${s.id}/recalculation`)).data);expect(result).toMatchObject({complete:true,aggregates:{incorrect:1,score:0}});expect(result.items[0]).toMatchObject({reasonCode:'key_changed',originalQuestionVersion:1,comparedQuestionVersion:2});
  const [after]=await db`SELECT report FROM question_sessions WHERE id=${s.id}`;expect(after!.report).toEqual(originalReport);const [event]=await db`SELECT correct FROM question_answers WHERE item_id=${item.id}`;expect(event!.correct).toBe(true);
 });
 it('current annulment excludes the item and yields a null score with zero denominator',async()=>{
  await publishSynthetic(uuid(),3,null,choices,'Synthetic public stem',true);
  const result=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${publicSession}/recalculation`)).data);expect(result.aggregates).toMatchObject({annulled:1,denominator:0,score:null});expect(result.items[0]?.reference?.correctKey).toBeNull();
 });
 it('material content changes hide the comparison reference and prohibit a partial score',async()=>{
  await publishSynthetic(uuid(),4,'A',choices,'Changed synthetic public stem');const result=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${publicSession}/recalculation`)).data);expect(result).toMatchObject({complete:false,aggregates:null});expect(result.items[0]).toMatchObject({outcome:'not_comparable',reasonCode:'content_not_comparable',reference:null});
 });
 it('a withdrawn published successor never falls back to an older reviewed version',async()=>{
  await db`UPDATE question_bank SET catalog_status='withdrawn' WHERE id=${previous}`;const result=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${publicSession}/recalculation`)).data);expect(result).toMatchObject({complete:false,aggregates:null});expect(result.items[0]).toMatchObject({outcome:'unavailable',reference:null,comparedQuestionId:null});
  await db`UPDATE question_bank SET catalog_status='published' WHERE id=${previous}`;
 });
 it('revoked licensing yields no references, and the original frozen report stays untouched',async()=>{
  await db`UPDATE question_sources SET rights_status='revoked' WHERE id=${source}`;const result=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${publicSession}/recalculation`)).data);expect(result).toMatchObject({complete:false,aggregates:null});expect(result.items[0]).toMatchObject({outcome:'unavailable',reasonCode:'rights_unavailable',reference:null,comparedQuestionId:null});
  const [after]=await db`SELECT report FROM question_sessions WHERE id=${publicSession}`;expect(after!.report).toEqual(originalReport);
 });
 it('deadline settlement keeps an explicit null answer incorrect, without treating it as untouched',async()=>{
  const s=await start([privateQ]);expect((await answer(s.id,s.items[0]!.id,null)).status).toBe(200);await db`UPDATE question_sessions SET deadline=now()-interval '1 second' WHERE id=${s.id}`;
  expect((await call('/question-sessions')).status).toBe(200);const report=questionSessionReportSchema.parse((await call(`/question-sessions/${s.id}/report`)).data);expect(report).toMatchObject({incorrect:1,unanswered:0,denominator:1,score:0});
  const recalc=questionSessionRecalculationSchema.parse((await call(`/question-sessions/${s.id}/recalculation`)).data);expect(recalc.aggregates?.incorrect).toBe(1);
 });
});
