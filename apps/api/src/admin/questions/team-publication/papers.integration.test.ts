/** Actual immutable28k local corpus; all changes and learner attempts roll back. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterAll,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import type {Tx} from '@remoa/db';
import {Hono} from 'hono';
import type {Env} from '../../../app';
import {examPaperListResultSchema,examPaperDetailSchema,examBuilderParamsSchema,questionSessionConfigSchema} from '@remoa/contracts';
const fixture=vi.hoisted(()=>({tx:null as Tx|null}));
vi.mock('../../../db',async original=>({...await original<typeof import('../../../db')>(),run:async(_u:string,fn:(tx:Tx)=>Promise<unknown>)=>{if(!fixture.tx)throw Error('fixture_required');return fn(fixture.tx);}}));
vi.mock('../../../cache',()=>({invalidate:vi.fn(async()=>{})}));
vi.mock('../../../storage/storage',()=>({presignGet:vi.fn(async()=> 'https://example.invalid/asset'),getBytes:vi.fn(),putBytes:vi.fn(),headObject:vi.fn(),deleteObject:vi.fn()}));
const enabled=process.env.G29_RELIABILITY_SQL_TEST==='1'&&!!process.env.DATABASE_URL;
if(enabled){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/remoa_g29_reliability_f33_test_20261019')throw Error('disposable_reliability_clone_required');}
describe.skipIf(!enabled)('G29 real source excerpts and imported learner flow',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('indexes841 excerpt groups/822 pinned PDFs, paginates/searches/coursefilters, starts only eligible original numbers and preserves signatures',async()=>{
 const{db}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});process.env.SHARE_SECRET='synthetic-reliability-cursor';process.env.QUESTIONS_BANK_STUDENT_ENABLED='true';
 try{await db.transaction(async tx=>{fixture.tx=tx;await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='10s'`);
 const{indexTeamPapers}=await import('./papers');const[batchRow]=await tx.execute<{actor_id:string}>(sql`SELECT actor_id FROM question_team_batches LIMIT 1`);const actor=batchRow!.actor_id;
 const fingerprint=async()=>{await tx.execute(sql`SET LOCAL ROLE NONE`);const[r]=await tx.execute<{fp:string}>(sql`SELECT md5(string_agg(to_jsonb(q)::text,'' ORDER BY q.id)) fp FROM question_bank q WHERE validation_kind='remoa_team_attested'`);return r!.fp;};const before=await fingerprint();await tx.execute(sql`SET LOCAL ROLE NONE`);
 const audit={before:vi.fn(),after:vi.fn()},input={idempotencyKey:randomUUID(),reason:'Indexar o acervo aprovado por Remoa como recortes de fontes'};
 const indexStarted=performance.now();const indexed=await indexTeamPapers(tx,actor,input,audit);const indexMs=Math.round(performance.now()-indexStarted);expect(indexed).toMatchObject({ok:true,data:{papers:841,documents:822,occurrences:28188,coverageKind:'source_excerpt'}});expect(await fingerprint()).toBe(before);
 const{writeAudit}=await import('../../core/audit');await writeAudit({actorType:'admin',actorId:actor,action:'question.import',targetType:'route',targetId:'synthetic-paper-index',reason:input.reason,result:'success',after:audit.after.mock.calls.at(-1)![0]},tx);
 expect(await indexTeamPapers(tx,actor,input,audit)).toMatchObject({ok:true,data:{replayed:true,papers:841}});
 await tx.execute(sql`ANALYZE exam_papers,exam_question_occurrences`);
 const{paperCatalogSQL}=await import('../../../questions/catalog/service');const [plan]=await tx.execute(sql`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${paperCatalogSQL(actor,{limit:25},0,25)}`);await writeFile('/tmp/g29-paper-catalog-plan.json',JSON.stringify(plan));
 const user=randomUUID();await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${user},${user+'@example.invalid'})`);
 const{examsRoutes}=await import('../../../routes/questions');const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('userId',user);await next();});app.route('/v1/exams',examsRoutes());
 const request=async(path:string)=>{const r=await app.request('/v1/exams'+path);expect(r.status).toBe(200);return(await r.json()).data;};
 const first=examPaperListResultSchema.parse(await request('/catalog?limit=25'));expect(first.total).toBe(841);expect(first.items).toHaveLength(25);expect(first.nextCursor).toBeTruthy();expect(first.items.every(p=>p.coverage?.kind==='source_excerpt'&&p.coverage.expectedQuestionCount===null)).toBe(true);
 const second=examPaperListResultSchema.parse(await request('/catalog?limit=25&cursor='+encodeURIComponent(first.nextCursor!)));expect(new Set([...first.items,...second.items].map(p=>p.id)).size).toBe(50);
 const wrongCursor=await app.request('/v1/exams/catalog?course=medicine&cursor='+encodeURIComponent(first.nextCursor!));expect(wrongCursor.status).toBe(422);
 const malformed=await app.request('/v1/exams/catalog?cursor='+encodeURIComponent(first.nextCursor!+'.extra'));expect(malformed.status).toBe(422);
 const literalWildcard=examPaperListResultSchema.parse(await request('/catalog?search=%25'));expect(literalWildcard.items).toHaveLength(0);
 const physical=examPaperListResultSchema.parse(await request('/catalog?course=physical_education'));expect(physical.items.length).toBeGreaterThan(0);expect(physical.items.every(p=>p.professionCode==='physical_education')).toBe(true);
 const search=examPaperListResultSchema.parse(await request('/catalog?search='+encodeURIComponent(first.items[0]!.institution)));expect(search.items.length).toBeGreaterThan(0);
 const detail=examPaperDetailSchema.parse(await request('/'+physical.items[0]!.id));expect(detail.questions.length).toBe(detail.paper.coverage?.availableQuestionCount);expect(detail.questions.every(q=>q.teamDisclosure?.professionCode==='physical_education')).toBe(true);
 const{questionSessionService}=await import('../../../questions/sessions/service');const count=Math.min(10,detail.paper.coverage!.scorableQuestionCount);expect(count).toBeGreaterThan(0);
 const session=await questionSessionService.create(user,questionSessionConfigSchema.parse({examId:detail.paper.id,count,mode:'study',timerSec:null,shuffle:false}),randomUUID());expect(session.items).toHaveLength(count);
 expect(session.items.every(i=>i.originalNumber&&i.question.availability==='active')).toBe(true);
 for(const item of session.items){const original=detail.questions.find(q=>q.id===item.question.id)!.occurrences!.items.find(o=>o.examId===detail.paper.id);expect(item.originalNumber).toBe(original!.originalNumber);}expect(JSON.stringify(session)).not.toMatch(/"correctKey"/);
 const{examBuilder}=await import('../../../questions/builder/service');
 const params=examBuilderParamsSchema.parse({source:'catalog',areaIds:[],topicIds:[],matrixItemIds:[],difficulties:[],progress:'all',boardId:null,course:'physical_education',count:10,distribution:'balanced',timePerQuestionSec:null,mode:'study',shuffle:false});
 const available=await examBuilder.availability(user,params);expect(available.total).toBe(312);
 const easy=await examBuilder.preview(user,{params:{...params,difficulties:['easy']},pinnedIds:[],excludedIds:[]});expect(easy.items).toHaveLength(0);expect(easy.allocation.shortfall).toBe(10);
 const preview=await examBuilder.preview(user,{params,pinnedIds:[],excludedIds:[]});expect(preview.items).toHaveLength(10);expect(preview.items.every(i=>i.areaId===null&&i.topicId===null&&i.difficultyAssessment==='unassessed')).toBe(true);
 const built=await questionSessionService.create(user,questionSessionConfigSchema.parse({questionIds:preview.items.map(i=>i.questionId),count:10,mode:'study',timerSec:null,shuffle:false}),randomUUID());expect(built.items).toHaveLength(10);expect(JSON.stringify(built)).not.toMatch(/"correctKey"/);
 const item=built.items[0]!,answer={selectedKey:'A' as const,mutationId:randomUUID(),revision:item.revision,elapsedMs:1000};
 const saved=await questionSessionService.answer(user,built.id,item.id,answer);expect(await questionSessionService.answer(user,built.id,item.id,answer)).toEqual(saved);
 const resumed=await questionSessionService.get(user,built.id);expect(resumed.items[0]!.answered).toBe(true);
 const report=await questionSessionService.finish(user,built.id);expect(report.items).toHaveLength(10);expect(JSON.stringify(report)).toMatch(/"correctKey"/);expect(await fingerprint()).toBe(before);
 await writeFile('/tmp/g29-exams-e2e-receipt.json',JSON.stringify({localOnly:true,productionWrites:0,statementTimeoutMs:5000,indexMs,papers:841,documents:822,occurrences:28188,coverageKind:'source_excerpt',expectedQuestionCount:null,scorablePhysical:312,preview10:true,emptyTaxonomy:true,easyFilterHonestZero:true,session:true,answerIdempotency:true,resume:true,finishReport:true,questionsUnchanged:true},null,2));
 throw Error('fixture_rollback');
 });}catch(e){if(!(e instanceof Error)||e.message!=='fixture_rollback')throw e;}finally{fixture.tx=null;}
 },120000);
});
