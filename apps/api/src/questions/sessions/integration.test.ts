/** Synthetic API fixtures on a deliberately named isolated database only. */
import { randomUUID } from 'node:crypto';
import {questionSessionsListSchema,questionInstitutionListSchema,questionListQuerySchema,questionPublicSchema,questionListResultSchema} from '@remoa/contracts';
import type { QuestionSessionPublic, QuestionSessionReport, QuestionReferenceAfterAnswer } from '@remoa/contracts';
import type { db as database } from '@remoa/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../../cache',()=>({invalidate:vi.fn(async()=>{})}));
const url=process.env.DATABASE_URL;
if(url && !new URL(url).pathname.includes('f33_test'))throw Error('F33 requires isolated f33_test database');
let db:typeof database.$client | null=null;
describe.skipIf(!url)('F33 HTTP catalog and sessions',()=>{
  let app:ReturnType<typeof import('../../app').createApp>;
  const owner=randomUUID(),other=randomUUID(),reviewer=randomUUID(),source=randomUUID(),area=randomUUID(),topic=randomUUID();
  const privateQ=randomUUID(),publicQ=randomUUID(),annulled=randomUUID(),paper=randomUUID();
  const alternatives=['A','B','C','D','E'].map(key=>({key,text:'Synthetic choice '+key}));
  async function request(path:string,method='GET',body?:unknown,user:string=owner,key?:string){const res=await app.request('/v1'+path,{method,headers:{authorization:'Bearer '+user,...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,queries:Number(res.headers.get('x-remoa-queries')),body:await res.json() as {data:QuestionSessionPublic & QuestionSessionReport & Omit<QuestionReferenceAfterAnswer, 'annulled'> & {total:number;nextCursor:string;paper:{questionCount:number};cards:number;cardIds:string[];boardId:string|null};error?:{message:string}}};}
  beforeAll(async()=>{
    db=(await import('@remoa/db')).db.$client;
    process.env.SHARE_SECRET='synthetic-f33-cursor-secret';
    for(const id of [owner,other,reviewer])await db!`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@f33.example'})`;
    await db!`UPDATE profiles SET role='reviewer',name='Synthetic reviewer',crm='12345-SP' WHERE user_id=${reviewer}`;
    await db!`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${source},'Synthetic source','Synthetic','https://example.org','authorized','Synthetic test authorization')`;
    await db!`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic area')`;
    await db!`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area})`;
    for(const id of [privateQ,publicQ,annulled])await db!`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin) VALUES(${id},${owner},'objective','medium',${'Synthetic question '+id},${JSON.stringify(alternatives)}::text::jsonb,'E','Synthetic E','student','Synthetic explanation','user_authored')`;
    for(const id of [publicQ,annulled]){
      await db!`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${source},status='approved',rights_status='authorized',integrity_confirmed=true,key_final=true,enamed_confirmed=true,enamed_area_id=${area},enamed_topic_id=${topic},content_hash=${'a'.repeat(64)},reviewed_hash=${'a'.repeat(64)},reviewer_name='Synthetic reviewer',reviewer_crm='12345-SP',reference_date='2026-10-08' WHERE id=${id}`;
      await db!`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${reviewer},'Synthetic reviewer','12345-SP',${'a'.repeat(64)},'approved','Synthetic test only','2026-10-08')`;
      await db!`UPDATE question_bank SET catalog_status='published',availability=${id===annulled?'annulled':'active'} WHERE id=${id}`;
    }
    await db!`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${paper},${source},'Synthetic paper',${'Synthetic institution '+owner},2026,'test','A','published',true)`;
    for(const [i,q]of [publicQ,annulled].entries())await db!`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number,annulled) VALUES(${paper},${q},${i+1},${String(i+1)},${q===annulled})`;
    const {createApp}=await import('../../app');app=createApp({webOrigin:'http://localhost:3000',verifyToken:async token=>([owner,other] as string[]).includes(token)?{userId:token,sessionId:null,account:{hasProfile:true,deletedAt:null,suspendedAt:null}}:null});
  });
  afterAll(async()=>{
    if(!db)return;
    await db`DELETE FROM question_sessions WHERE user_id IN (${owner},${other})`;
    await db`DELETE FROM exam_papers WHERE id=${paper}`;
    await db`DELETE FROM question_bank WHERE id IN (${privateQ},${publicQ},${annulled})`;
    await db`DELETE FROM question_sources WHERE id=${source}`;
    await db`DELETE FROM enamed_taxonomy WHERE id=${topic}`;await db`DELETE FROM enamed_taxonomy WHERE id=${area}`;
    await db`DELETE FROM auth.users WHERE id IN (${owner},${other},${reviewer})`;
    await db.end({timeout:1});
  });
  it('institution spans two papers while examId selects only one, and options count papers without question payloads',async()=>{
    const second=randomUUID(),institution='Synthetic institution '+owner;
    await db!`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${second},${source},'Synthetic second',${institution.toUpperCase()},2026,'test','B','published',true)`;
    await db!`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) VALUES(${second},${annulled},1,'1')`;
    try{
      const all=await request('/questions?scope=catalog&sourceId='+source+'&institution='+encodeURIComponent('  '+institution.toLowerCase()+'  '));expect(all.status).toBe(200);expect(all.body.data.total).toBe(2);
      const one=await request('/questions?scope=catalog&sourceId='+source+'&institution='+encodeURIComponent(institution)+'&examId='+second);expect(one.body.data.total).toBe(1);
      const options=await request('/question-institutions');expect(options.status).toBe(200);const parsed=questionInstitutionListSchema.parse(options.body.data);
      expect(parsed.items.find(i=>i.name.toLowerCase()===institution.toLowerCase())?.paperCount).toBe(2);expect(parsed.truncated).toBe(false);
      await db!`UPDATE exam_papers SET institution='Another synthetic institution' WHERE id=${second}`;
      const mismatch=await request('/questions?scope=catalog&sourceId='+source+'&institution='+encodeURIComponent(institution)+'&examId='+second);expect(mismatch.body.data.total).toBe(0);
      await db!`UPDATE exam_papers SET status='withdrawn' WHERE id=${second}`;
      const after=questionInstitutionListSchema.parse((await request('/question-institutions')).body.data);expect(after.items.find(i=>i.name.toLowerCase()===institution.toLowerCase())?.paperCount).toBe(1);
    }finally{await db!`DELETE FROM exam_papers WHERE id=${second}`;}
  });
  it('authentication, private ownership, keyset filters and strict public projection',async()=>{
    expect((await request('/questions/'+privateQ,'GET',undefined,other)).status).toBe(404);
    expect((await request('/questions','GET',undefined,'invalid')).status).toBe(401);
    const result=await request('/questions?scope=catalog&sourceId='+source+'&limit=1');expect(result.status).toBe(200);expect(result.body.data.items).toHaveLength(1);expect(result.body.data.total).toBe(2);
    expect(JSON.stringify(result.body)).not.toMatch(/correctKey|explanation|expectedAnswer|distractorNotes/);
    const cursor=result.body.data.nextCursor;expect(cursor).toBeTruthy();
    const next=await request('/questions?scope=catalog&sourceId='+source+'&limit=1&cursor='+encodeURIComponent(cursor));expect(next.body.data.items[0]!.id).not.toBe(result.body.data.items[0]!.id);
    expect(next.body.data.total).toBe(2);expect(result.queries).toBeLessThanOrEqual(4);
    const {encodeQuestionCursor}=await import('../catalog/service');
    const emptyCursor=encodeQuestionCursor('2000-01-01T00:00:00Z',publicQ,owner,questionListQuerySchema.parse({scope:'catalog',sourceId:source,limit:1}));
    const empty=await request('/questions?scope=catalog&sourceId='+source+'&limit=1&cursor='+encodeURIComponent(emptyCursor));expect(empty.body.data.items).toHaveLength(0);expect(empty.body.data.total).toBe(2);
    expect((await request('/questions?scope=catalog&sourceId='+source+'&limit=1&cursor='+encodeURIComponent(cursor),'GET',undefined,other)).status).toBe(422);
    expect((await request('/questions/'+privateQ+'/user-state','PUT',{favorite:true,doubtful:true,annotation:'Synthetic annotation'})).status).toBe(200);
    expect((await request('/questions?state=favorite')).body.data.items.map((q)=>q.id)).toContain(privateQ);
    expect((await request('/exams/'+paper)).body.data.paper.questionCount).toBe(2);
  });
  it('study first answer immutable, mutation replay, revisions, no automatic FSRS',async()=>{
    const config={mode:'study',questionIds:[privateQ],count:1};const key=randomUUID();
    const created=await request('/question-sessions','POST',config,owner,key);expect(created.status).toBe(200);
    const session=created.body.data;const item=session.items[0]!;expect(JSON.stringify(session)).not.toMatch(/correctKey|explanation|referenceSnapshot/);
    const[snapshot]=await db!`SELECT payload_public FROM question_session_items WHERE id=${item.id}`;
    try{
      await db!`UPDATE question_session_items SET payload_public=payload_public||jsonb_build_object('correctKey','E') WHERE id=${item.id}`;
      const invalid=await request('/question-sessions/'+session.id);expect(invalid.status).toBe(500);expect(JSON.stringify(invalid.body)).not.toMatch(/correctKey|referenceSnapshot/);
    }finally{await db!`UPDATE question_session_items SET payload_public=${JSON.stringify(snapshot!.payload_public)}::text::jsonb WHERE id=${item.id}`;}
    expect((await request('/question-sessions','POST',config,owner,key)).body.data.id).toBe(session.id);
    expect((await request('/question-sessions','POST',{...config,count:2},owner,key)).status).toBe(409);
    expect(item.doubtful).toBe(true);
    const path='/question-sessions/'+session.id+'/items/'+item.id;
    expect((await request(path+'/reference')).status).toBe(409);
    const input={selectedKey:'A',mutationId:randomUUID(),revision:0,elapsedMs:100};
    const [a,b]=await Promise.all([request(path+'/answer','PUT',input),request(path+'/answer','PUT',input)]);expect(a.status).toBe(200);expect(b.status).toBe(200);expect(a.body.data).toEqual(b.body.data);
    expect(JSON.stringify(a.body)).not.toMatch(/correct|explanation/);
    expect((await request(path+'/reference')).body.data.correctKey).toBe('E');
    expect((await request(path+'/answer','PUT',{...input,selectedKey:'E',mutationId:randomUUID(),revision:1})).status).toBe(409);
    expect((await request('/question-sessions/'+session.id,'GET',undefined,other)).status).toBe(404);
    const finished=await request('/question-sessions/'+session.id+'/finish','POST',{});expect(finished.body.data.score).toBe(0);expect(finished.body.data.incorrect).toBe(1);
    expect((await request('/question-sessions/'+session.id+'/report')).body.data).toEqual(finished.body.data);
    expect((await request('/question-sessions/'+session.id+'/review','POST',{})).body.data.cards).toBe(0);
    const [attempts]=await db!`SELECT count(*)::int n FROM attempts WHERE user_id=${owner}`;expect(attempts!.n).toBe(0);
    const [answers]=await db!`SELECT count(*)::int n FROM question_answers WHERE session_id=${session.id}`;expect(answers!.n).toBe(1);
  });
  it('explicit review advances valid own flow units once and excludes foreign/archived cards',async()=>{
    const [ownBoard]=await db!`INSERT INTO boards(user_id,title) VALUES(${owner},'Synthetic flow board') RETURNING id`;
    const [foreignBoard]=await db!`INSERT INTO boards(user_id,title) VALUES(${other},'Synthetic foreign board') RETURNING id`;
    const [archivedBoard]=await db!`INSERT INTO boards(user_id,title,archived_at) VALUES(${owner},'Synthetic archived board',now()) RETURNING id`;
    const [flow]=await db!`INSERT INTO cards(board_id,type,title,payload) VALUES(${ownBoard!.id},'flow','Synthetic flow',${JSON.stringify({steps:[{id:'one'},{id:'two'}]})}::text::jsonb) RETURNING id`;
    const [foreign]=await db!`INSERT INTO cards(board_id,title) VALUES(${foreignBoard!.id},'Synthetic foreign') RETURNING id`;
    const [archived]=await db!`INSERT INTO cards(board_id,title) VALUES(${archivedBoard!.id},'Synthetic archived') RETURNING id`;
    for(const [card,sub]of [[flow!.id,'one'],[flow!.id,'two'],[flow!.id,'stale'],[foreign!.id,''],[archived!.id,'']])await db!`INSERT INTO fsrs_state(user_id,card_id,sub_id,due) VALUES(${owner},${card},${sub},now()+interval '1 day')`;
    await db!`UPDATE question_bank SET card_ids=ARRAY[${flow!.id}::uuid,${foreign!.id}::uuid,${archived!.id}::uuid] WHERE id=${privateQ}`;
    const [session]=await db!`SELECT s.id FROM question_sessions s JOIN question_session_items i ON i.session_id=s.id WHERE s.user_id=${owner} AND i.question_id=${privateQ} AND s.status='finished' ORDER BY s.created_at DESC LIMIT 1`;
    expect((await request('/question-sessions/'+session!.id+'/review','POST',{})).body.data.cards).toBe(1);
    expect((await request('/question-sessions/'+session!.id+'/review','POST',{})).body.data.cards).toBe(0);
    const rows=await db!`SELECT card_id,sub_id,due<=now() due_now FROM fsrs_state WHERE user_id=${owner}`;
    expect(rows.filter(r=>r.due_now).map(r=>r.sub_id).sort()).toEqual(['one','two']);
    await db!`UPDATE question_bank SET card_ids='{}' WHERE id=${privateQ}`;
    await db!`DELETE FROM boards WHERE id IN (${ownBoard!.id},${foreignBoard!.id},${archivedBoard!.id})`;
  });
  it('insufficient filtered pool fails before creating a session and exposes the available count',async()=>{
    const key=randomUUID();const result=await request('/question-sessions','POST',{mode:'study',filters:{scope:'mine'},count:200},owner,key);
    expect(result.status).toBe(422);expect(result.body.error?.message).toBe('insufficient_questions:1');
    const [count]=await db!`SELECT count(*)::int n FROM question_sessions WHERE user_id=${owner} AND idempotency_key=${key}`;expect(count!.n).toBe(0);
  });
  it('archived maps and deleted cards disappear from current and frozen public links',async()=>{
    const [board]=await db!`INSERT INTO boards(user_id,title) VALUES(${owner},'Synthetic link board') RETURNING id`;
    const [card]=await db!`INSERT INTO cards(board_id,title) VALUES(${board!.id},'Synthetic linked card') RETURNING id`;
    await db!`UPDATE question_bank SET board_id=${board!.id},card_ids=ARRAY[${card!.id}::uuid] WHERE id=${privateQ}`;
    const started=await request('/question-sessions','POST',{mode:'study',questionIds:[privateQ],count:1},owner,randomUUID());expect(started.status).toBe(200);
    await db!`UPDATE cards SET deleted_at=now() WHERE id=${card!.id}`;
    const deleted=await request('/questions/'+privateQ);expect(deleted.body.data.cardIds).toEqual([]);
    await db!`UPDATE boards SET archived_at=now() WHERE id=${board!.id}`;
    const archived=await request('/questions/'+privateQ);expect(archived.body.data.boardId).toBeNull();expect(archived.body.data.cardIds).toEqual([]);
    const resumed=await request('/question-sessions/'+started.body.data.id);expect(resumed.body.data.items[0]!.question.boardId).toBeNull();expect(resumed.body.data.items[0]!.question.cardIds).toEqual([]);
    await db!`UPDATE question_bank SET board_id=null,card_ids='{}' WHERE id=${privateQ}`;await db!`DELETE FROM boards WHERE id=${board!.id}`;
  });
  it('simulation edits, competing revisions, annulled denominator and original exam integrity',async()=>{
    expect((await request('/question-sessions','POST',{mode:'simulation',examId:paper,count:1},owner,randomUUID())).status).toBe(409);
    const started=await request('/question-sessions','POST',{mode:'simulation',examId:paper,count:2},owner,randomUUID());expect(started.status).toBe(200);
    const s=started.body.data;const item=s.items[0]!;const path='/question-sessions/'+s.id+'/items/'+item.id;
    const answer={selectedKey:'A',mutationId:randomUUID(),revision:0,elapsedMs:100};expect((await request(path+'/answer','PUT',answer)).status).toBe(200);
    expect((await request(path+'/reference')).status).toBe(409);expect((await request('/questions?state=wrong')).body.data.items.map((q)=>q.id)).not.toContain(publicQ);
    const [a,b]=await Promise.all([request(path+'/answer','PUT',{...answer,selectedKey:'E',mutationId:randomUUID(),revision:1}),request(path+'/answer','PUT',{...answer,selectedKey:'B',mutationId:randomUUID(),revision:1})]);expect([a.status,b.status].sort()).toEqual([200,409]);
    const finish=await request('/question-sessions/'+s.id+'/finish','POST',{});expect(finish.status).toBe(200);expect(finish.body.data.annulled).toBe(1);expect(finish.body.data.denominator).toBe(1);
    await db!`UPDATE question_bank SET availability='superseded' WHERE id=${publicQ}`;
    expect((await request(path+'/reference')).body.data.correctKey).toBe('E');
    expect((await request('/question-sessions/'+s.id)).body.data.items[0]!.question.stem).toContain('Synthetic');
    await db!`UPDATE question_bank SET availability='active' WHERE id=${publicQ}`;
    expect((await request(path+'/reference')).status).toBe(200);
  });
  it('explicit null timer disables an exam suggested duration',async()=>{
    await db!`UPDATE exam_papers SET duration_sec=3600 WHERE id=${paper}`;
    const started=await request('/question-sessions','POST',{mode:'simulation',examId:paper,count:2,timerSec:null},owner,randomUUID());expect(started.status).toBe(200);expect(started.body.data.deadline).toBeNull();
    const timed=await request('/question-sessions','POST',{mode:'simulation',examId:paper,count:2,timerSec:60},owner,randomUUID());expect(timed.status).toBe(200);expect(timed.body.data.deadline).not.toBeNull();
  });
  it('booklet provenance is authorized, bounded and independent of answer references',async()=>{
    const ids=Array.from({length:12},()=>randomUUID());
    try{
      for(const [ordinal,id]of ids.entries()){
        await db!`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${id},${source},'Synthetic provenance paper','Synthetic institution',2026,${id},${String(ordinal)},'published',true)`;
        await db!`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) VALUES(${id},${publicQ},1,${String(100+ordinal)})`;
      }
      const response=await request('/questions/'+publicQ);expect(response.status).toBe(200);const question=questionPublicSchema.parse(response.body.data);
      expect(question.occurrences).toMatchObject({total:13,truncated:true});expect(question.occurrences!.items).toHaveLength(10);expect(response.queries).toBeLessThanOrEqual(4);
      expect(JSON.stringify(question)).not.toMatch(/correctKey|explanation|expectedAnswer/);
      await db!`UPDATE exam_papers SET status='withdrawn' WHERE id=ANY(${ids})`;
      const after=questionPublicSchema.parse((await request('/questions/'+publicQ)).body.data);expect(after.occurrences).toMatchObject({total:1,truncated:false});expect(after.occurrences!.items[0]).toMatchObject({examId:paper,booklet:'A',originalNumber:'1',year:2026});
    }finally{await db!`DELETE FROM exam_papers WHERE id=ANY(${ids})`;}
  });
  it('draft successors do not warn, and withdrawal never resurrects an older annulled version',async()=>{
    const started=await request('/question-sessions','POST',{mode:'simulation',examId:paper,count:2,timerSec:null},owner,randomUUID());expect(started.status).toBe(200);const session=started.body.data;
    await request('/question-sessions/'+session.id+'/finish','POST',{});const item=session.items.find(i=>i.question.id===annulled)!;const refPath='/question-sessions/'+session.id+'/items/'+item.id+'/reference';
    const clone=randomUUID();
    try{
      await db!`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,visibility,source_id,status,rights_status,integrity_confirmed,key_final,enamed_confirmed,enamed_area_id,enamed_topic_id,content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,supersedes_id,version,canonical_id)
        SELECT ${clone},user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,visibility,source_id,status,rights_status,integrity_confirmed,key_final,enamed_confirmed,enamed_area_id,enamed_topic_id,content_hash,reviewed_hash,reviewer_name,reviewer_crm,reference_date,id,version+1,coalesce(canonical_id,id) FROM question_bank WHERE id=${annulled}`;
      expect((await request(refPath)).body.data.obsolete).toBe(false);expect((await request('/questions/'+annulled)).status).toBe(200);
      await db!`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${clone},${reviewer},'Synthetic reviewer','12345-SP',${'a'.repeat(64)},'approved','Synthetic successor review','2026-10-08')`;
      await db!`UPDATE question_bank SET catalog_status='published',published_at=now() WHERE id=${clone}`;
      expect((await request(refPath)).body.data.obsolete).toBe(true);expect((await request('/questions/'+annulled)).status).toBe(404);
      await db!`UPDATE question_bank SET catalog_status='withdrawn' WHERE id=${clone}`;
      expect((await request('/questions/'+annulled)).status).toBe(404);const result=await request('/questions?scope=catalog&sourceId='+source);expect(questionListResultSchema.parse(result.body.data).items.some(q=>q.canonicalId===annulled)).toBe(false);
      expect((await request(refPath)).body.data.obsolete).toBe(false);expect((await request('/question-sessions/'+session.id+'/report')).body.data.annulled).toBe(1);
    }finally{await db!`DELETE FROM question_bank WHERE id=${clone}`;}
  });
  it('server deadline closes on reload, unanswered is zero score and revoked references remain hidden',async()=>{
    const started=await request('/question-sessions','POST',{mode:'simulation',questionIds:[publicQ],count:1,timerSec:60},owner,randomUUID());const s=started.body.data;
    await db!`UPDATE question_sessions SET deadline=now()-interval '1 second' WHERE id=${s.id}`;
    const recent=await request('/question-sessions');expect(recent.status).toBe(200);const summary=questionSessionsListSchema.parse(recent.body.data).find(row=>row.id===s.id)!;expect(recent.queries).toBeLessThanOrEqual(10);expect(summary.status).toBe('expired');expect(summary.count).toBe(1);expect(summary.answeredCount).toBe(0);expect(summary).not.toHaveProperty('items');const resumed=await request('/question-sessions/'+s.id);expect(resumed.body.data.status).toBe('expired');
    const report=await request('/question-sessions/'+s.id+'/report');expect(report.body.data.unanswered).toBe(1);expect(report.body.data.score).toBe(0);
    expect((await request('/question-sessions/'+s.id+'/items/'+s.items[0]!.id+'/answer','PUT',{selectedKey:'E',mutationId:randomUUID(),revision:0,elapsedMs:1})).status).toBe(409);
    await db!`UPDATE question_sources SET rights_status='revoked' WHERE id=${source}`;
    expect((await request('/questions/'+publicQ)).status).toBe(404);
    const hidden=await request('/question-sessions/'+s.id);expect(hidden.status).toBe(200);expect(hidden.body.data.items[0]!.question.availability).toBe('unavailable');expect(hidden.body.data.items[0]!.question.assets).toEqual([]);expect(hidden.body.data.items[0]!.question.occurrences).toEqual({items:[],total:0,truncated:false});expect(hidden.body.data.items[0]!.question.stem).toBe('Questão indisponível.');
    expect((await request('/question-sessions')).status).toBe(200);const redacted=await request('/question-sessions/'+s.id+'/report');expect(redacted.status).toBe(200);expect(redacted.body.data.items[0]!.reference.correctKey).toBeNull();expect(redacted.body.data.items[0]!.reference.explanation).toBeNull();expect((await request('/question-sessions/'+s.id+'/items/'+s.items[0]!.id+'/reference')).status).toBe(404);
  });
});
