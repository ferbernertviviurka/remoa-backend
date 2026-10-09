import { randomUUID as uuid } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { questionReportQueueSchema,questionReportDetailSchema,questionReportResolveResultSchema } from '@remoa/contracts';
import { fakeToken,fakeVerifier } from '../../admin/core/test-helpers';
vi.mock('../../cache',()=>({invalidate:vi.fn(async()=>{})}));
const url=process.env.DATABASE_URL;if(url&&!new URL(url).pathname.includes('f33_test'))throw Error('isolated f33_test required');
describe.skipIf(!url)('FR23 report triage HTTP/DB',()=>{
 const admin=uuid(),reviewer=uuid(),student=uuid(),other=uuid(),qPublic=uuid(),qOwn=uuid(),qOther=uuid(),pubReports=[uuid(),uuid(),uuid()],ownReport=uuid(),otherReport=uuid(),users=[admin,reviewer,student,other];
 let db:typeof import('@remoa/db').db.$client,app:ReturnType<typeof import('../../app').createApp>;
 const call=async(path:string,method='GET',body?:unknown,user:string|null=admin,ago=60_000)=>{const response=await app.request('/v1'+path,{method,headers:{...(user?{authorization:'Bearer '+fakeToken(user,ago)}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,json:await response.json() as {data?:unknown;error?:{message:string;code:string}}};};
 const queue=async(user=reviewer,query='')=>{const r=await call('/editorial/questions/reports'+query,'GET',undefined,user);expect(r.status).toBe(200);return questionReportQueueSchema.parse(r.json.data);};
 const detail=async(id:string,user=reviewer)=>{const r=await call('/editorial/questions/reports/'+id,'GET',undefined,user);expect(r.status).toBe(200);return questionReportDetailSchema.parse(r.json.data);};
 beforeAll(async()=>{
  vi.stubEnv('SHARE_SECRET','synthetic-report-cursor-secret');db=(await import('@remoa/db')).db.$client;
  for(const id of users)await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@triage.example'})`;
  await db`UPDATE profiles SET role='admin' WHERE user_id=${admin}`;await db`UPDATE profiles SET role='reviewer',name='Triage reviewer',crm=null WHERE user_id=${reviewer}`;
  for(const [id,owner,visibility,origin,stem] of [[qPublic,null,'public','official_exam','Public synthetic question'],[qOwn,reviewer,'private','ai_generated','Own private statement'],[qOther,other,'private','ai_generated','OTHER_PRIVATE_SECRET']])await db`INSERT INTO question_bank(id,user_id,visibility,origin,type,difficulty,stem,expected_answer,source) VALUES(${id as string},${owner as string|null},${visibility as string},${origin as string},'discursive','medium',${stem as string},'HIDDEN_EXPECTED_ANSWER','ai')`;
  for(let i=0;i<pubReports.length;i++)await db`INSERT INTO question_reports(id,user_id,question_id,version,type,description,created_at) VALUES(${pubReports[i]!},${student},${qPublic},1,'key','Synthetic public report',${'2026-10-08T20:00:00.00000'+i+'Z'}::timestamptz)`;
  for(const [id,questionId]of[[ownReport,qOwn],[otherReport,qOther]])await db`INSERT INTO question_reports(id,user_id,question_id,version,type,description) VALUES(${id!},${student},${questionId!},1,'rights','Synthetic private issue')`;
  const {createApp}=await import('../../app');app=createApp({webOrigin:'http://localhost:3000',verifyToken:fakeVerifier(users)});
 });
 afterAll(async()=>{vi.unstubAllEnvs();await db`DELETE FROM question_reports WHERE question_id IN (${qPublic},${qOwn},${qOther})`;await db`DELETE FROM question_bank WHERE id IN (${qPublic},${qOwn},${qOther})`;await db`DELETE FROM auth.users WHERE id IN (${admin},${reviewer},${student},${other})`;await db.end({timeout:1});});
 it('requires authentication and staff role; student cannot discover administrative/editorial queue',async()=>{
  expect((await call('/editorial/questions/reports','GET',undefined,null)).status).toBe(401);
  expect((await call('/editorial/questions/reports','GET',undefined,student)).status).toBe(404);
  expect((await call('/admin/questions/reports','GET',undefined,student)).status).toBe(404);
  const adminQueue=await call('/admin/questions/reports?questionId='+qPublic);expect(adminQueue.status).toBe(200);expect(questionReportQueueSchema.parse(adminQueue.json.data).items.map(r=>r.id)).toEqual(expect.arrayContaining(pubReports));
 });
 it('reviewer sees public and own private reports, never foreign private or reporter identity',async()=>{
  const publicQueue=await queue(reviewer,'?questionId='+qPublic),ownQueue=await queue(reviewer,'?questionId='+qOwn),foreignQueue=await queue(reviewer,'?questionId='+qOther);const r={items:[...publicQueue.items,...ownQueue.items]};expect(r.items.map(i=>i.id)).toEqual(expect.arrayContaining([...pubReports,ownReport]));expect(foreignQueue.items).toEqual([]);expect(JSON.stringify(r)).not.toMatch(/userId|email|reporter|HIDDEN_EXPECTED_ANSWER|OTHER_PRIVATE_SECRET/);
  expect((await call('/editorial/questions/reports/'+otherReport,'GET',undefined,reviewer)).status).toBe(404);
  expect((await call('/admin/questions/reports/'+uuid())).status).toBe(404);expect((await call('/admin/questions/reports/'+'-'.repeat(36))).status).toBe(404);
  const a=await call('/admin/questions/reports/'+otherReport);expect(a.status).toBe(200);expect(questionReportDetailSchema.parse(a.json.data).question.stem).toBeNull();expect((await detail(ownReport)).question.stem).toBe('Own private statement');
 });
 it('paginates exact microsecond creation times, bounds cursor to filters/actor/role and rejects tampering',async()=>{
  let cursor:string|null=null;const found:string[]=[];
  do{const page=await queue(reviewer,'?limit=1&type=key&questionId='+qPublic+(cursor?'&cursor='+encodeURIComponent(cursor):''));found.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);
  expect(found).toEqual([...pubReports].reverse());
  const first=await queue(reviewer,'?limit=1&type=key&questionId='+qPublic);const c=first.nextCursor!;
  for(const path of ['?limit=1&type=rights&questionId='+qPublic+'&cursor='+encodeURIComponent(c),'?limit=1&type=key&questionId='+qPublic+'&cursor='+encodeURIComponent(c+'tamper')])expect((await call('/editorial/questions/reports'+path,'GET',undefined,reviewer)).status).toBe(422);
  expect((await call('/admin/questions/reports?limit=1&type=key&cursor='+encodeURIComponent(c))).status).toBe(422);
  expect((await call('/editorial/questions/reports?limit=101','GET',undefined,reviewer)).status).toBe(422);expect((await call('/editorial/questions/reports?status=invalid','GET',undefined,reviewer)).status).toBe(422);
 });
 it('resolution validates reason/status/time and audits admin denials; no hidden answers in detail',async()=>{
  expect((await call('/editorial/questions/reports/'+pubReports[0]+'/resolve','POST',{status:'resolved',reason:'no',expectedUpdatedAt:new Date()},reviewer)).status).toBe(422);
  expect((await call('/admin/questions/reports/'+uuid()+'/resolve','POST',{status:'resolved',reason:'Synthetic missing report',expectedUpdatedAt:new Date()})).status).toBe(404);
  expect((await call('/admin/questions/reports/'+'-'.repeat(36)+'/resolve','POST',{})).status).toBe(404);
  const d=await detail(pubReports[0]!);expect(JSON.stringify(d)).not.toMatch(/HIDDEN_EXPECTED_ANSWER|correctKey|reference|reporter|userId/);
  const [before]=await db`SELECT count(*)::int n FROM admin_audit_log WHERE target_id=${pubReports[0]!} AND action='question.report_resolve'`;
  expect((await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{status:'resolved',reason:'no',expectedUpdatedAt:d.report.updatedAt})).status).toBe(422);
  expect((await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{status:'published',reason:'Synthetic invalid action',expectedUpdatedAt:d.report.updatedAt})).status).toBe(422);
  expect((await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{status:'resolved',reason:'Synthetic valid reason',expectedUpdatedAt:'not a date'})).status).toBe(422);
  const [after]=await db`SELECT count(*)::int n FROM admin_audit_log WHERE target_id=${pubReports[0]!} AND action='question.report_resolve'`;expect(after!.n-before!.n).toBe(3);
  expect((await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{status:'resolved',reason:'Synthetic valid reason',expectedUpdatedAt:d.report.updatedAt},admin,40*60_000)).status).toBe(403);
 });
 it('resolution is idempotent; stale competing status conflicts and no question/version is edited',async()=>{
  const d=await detail(pubReports[0]!),input={status:'resolved',reason:'Synthetic valid resolution',expectedUpdatedAt:d.report.updatedAt};
  const first=await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',input);expect(first.status).toBe(200);const result=questionReportResolveResultSchema.parse(first.json.data);expect(result.changed).toBe(true);expect(result.audit.before).toMatchObject({status:'open'});expect(result.audit.after).toMatchObject({status:'resolved',changed:true});
  const replay=await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',input);expect(replay.status).toBe(200);expect(questionReportResolveResultSchema.parse(replay.json.data).changed).toBe(false);
  expect((await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{...input,status:'dismissed'})).status).toBe(409);
  const reopened=await call('/admin/questions/reports/'+pubReports[0]+'/resolve','POST',{...input,status:'open',expectedUpdatedAt:result.report.updatedAt});expect(reopened.status).toBe(200);
  const [q]=await db`SELECT stem,version,expected_answer FROM question_bank WHERE id=${qPublic}`;expect(q).toMatchObject({stem:'Public synthetic question',version:1,expected_answer:'HIDDEN_EXPECTED_ANSWER'});
 });
 it('reviewer triage does not require CRM; admin mutation uses its own reauthenticated route',async()=>{
  const d=await detail(ownReport),input={status:'dismissed',reason:'Synthetic reviewer triage',expectedUpdatedAt:d.report.updatedAt};
  const r=await call('/editorial/questions/reports/'+ownReport+'/resolve','POST',input,reviewer);expect(r.status).toBe(200);expect(questionReportResolveResultSchema.parse(r.json.data).audit.actorType).toBe('user');
  expect((await call('/editorial/questions/reports/'+otherReport+'/resolve','POST',input,reviewer)).status).toBe(404);
  expect((await call('/editorial/questions/reports/'+ownReport+'/resolve','POST',input,admin)).status).toBe(403);
  await db`UPDATE profiles SET suspended_at=now(),suspended_reason='Synthetic suspension' WHERE user_id=${reviewer}`;expect((await call('/editorial/questions/reports','GET',undefined,reviewer)).status).toBe(403);await db`UPDATE profiles SET suspended_at=null,suspended_reason=null WHERE user_id=${reviewer}`;
 });
 it('serializes conflicting resolutions with one winner; filtering reflects the new state',async()=>{
  const id=pubReports[1]!,d=await detail(id);const results=await Promise.all(['resolved','dismissed'].map(status=>call('/admin/questions/reports/'+id+'/resolve','POST',{status,reason:'Synthetic concurrent resolution',expectedUpdatedAt:d.report.updatedAt})));
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);const final=await detail(id);const filtered=await queue(reviewer,'?status='+final.report.status+'&questionId='+qPublic);expect(filtered.items.map(i=>i.id)).toContain(id);
  expect((await call('/editorial/questions/reports/'+'-'.repeat(36),'GET',undefined,reviewer)).status).toBe(404);
 });
});
