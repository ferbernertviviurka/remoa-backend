/** G27 QA phase 4 — TEST ONLY: real createApp handlers + isolated PostgreSQL (remoa_f33_test_*), synthetic non-medical content, fake JWT, AI off. */
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {cors} from 'hono/cors';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {fakeToken,fakeVerifier} from '../../admin/core/test-helpers';
vi.mock('@remoa/ai',async original=>({...await original<typeof import('@remoa/ai')>(),generateJson:vi.fn(async()=>{throw Error('AI_OFF');}),generateText:vi.fn(async()=>{throw Error('AI_OFF');}),streamText:vi.fn(()=>{throw Error('AI_OFF');})}));
vi.mock('../../cache',()=>({invalidate:vi.fn(async()=>{})}));
vi.mock('../../inngest/client',async original=>({...await original<typeof import('../../inngest/client')>(),dispatchQuestionImport:vi.fn(async()=>false)}));
const apiPort=Number(process.env.G27_API_PORT??4361),webPort=Number(process.env.G27_WEB_PORT??4362);
describe.skipIf(process.env.G27_HTTP_HARNESS!=='1')('G27 QA HTTP server',()=>{
 const actors={student:randomUUID(),other:randomUUID(),c:randomUUID(),d:randomUUID(),e:randomUUID(),f:randomUUID(),g:randomUUID(),h:randomUUID(),reviewer:randomUUID(),admin:randomUUID()};
 const src=randomUUID(),srcRemoa=randomUUID(),paper=randomUUID(),areas=[randomUUID(),randomUUID()],topics=[[randomUUID(),randomUUID(),randomUUID()],[randomUUID(),randomUUID()]];
 const pub:string[]=[],drafts:string[]=[],extra:string[]=[];let privA:string,privB:string,privAnotherA:string;
 const diffs=['easy','medium','hard'] as const;const keys=['A','B','C','D','E'];
 const alt=JSON.stringify(keys.map(k=>({key:k,text:'Alternativa sintética '+k})));
 let db:typeof import('@remoa/db')['db']['$client'];let server:ReturnType<typeof serve>;let release:()=>void;const done=new Promise<void>(r=>{release=r;});
 const H='a'.repeat(64);
 async function publish(id:string,institutional:boolean){
  if(institutional){
   await db`UPDATE question_bank SET user_id=null,visibility='public',origin='remoa_authored',source_id=${srcRemoa},status='approved',rights_status='authorized',validation_kind='remoa_institutional',reviewer_name='Fundadora Sintética',reviewer_crm=null,content_hash=${H},reviewed_hash=${H},reference_date='2026-10-12' WHERE id=${id}`;
   await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,kind,content_hash,decision,reason,reference_date) VALUES(${id},${actors.admin},'Fundadora Sintética',null,'remoa_institutional',${H},'approved','Sintético QA G27','2026-10-12')`;
  }else{
   await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${src},status='approved',rights_status='authorized',integrity_confirmed=true,key_final=true,enamed_confirmed=true,content_hash=${H},reviewed_hash=${H},reviewer_name='Revisora Sintética',reviewer_crm='12345-SP',reference_date='2026-10-08' WHERE id=${id}`;
   await db`INSERT INTO question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${id},${actors.reviewer},'Revisora Sintética','12345-SP',${H},'approved','Sintético QA G27','2026-10-08')`;
  }
  await db`UPDATE question_bank SET catalog_status='published',published_at=now(),availability='active' WHERE id=${id}`;
 }
 const insertQ=async(id:string,owner:string|null,i:number,origin:string,stem:string,area:string|null,topic:string|null)=>
  db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id) VALUES(${id},${owner},'objective',${diffs[i%3]!},${stem},${alt}::text::jsonb,${keys[(i*2+1)%5]!},'x','student',${'EXPLICACAO_SECRETA_'+i},${origin},${area},${topic})`;
 beforeAll(async()=>{
  const raw=process.env.DATABASE_URL;if(process.env.NODE_ENV!=='test'||!raw)throw Error('needs test env');const u=new URL(raw);
  if(!/^\/remoa_f33_test_[a-z0-9_]+$/.test(u.pathname)||!['localhost','127.0.0.1'].includes(u.hostname))throw Error('Refusing nonisolated database');
  db=(await import('@remoa/db')).db.$client;
  for(const id of Object.values(actors))await db`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@g27qa.example'})`;
  await db`UPDATE profiles SET role='reviewer',name='Revisora Sintética',crm='12345-SP' WHERE user_id=${actors.reviewer}`;
  await db`UPDATE profiles SET role='admin',name='Administrador Sintético' WHERE user_id=${actors.admin}`;
  await db`DELETE FROM entitlement_grants WHERE user_id = ANY(${Object.values(actors)}::uuid[])`;
  await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence) VALUES(${src},'Fonte sintética QA','Sintética','https://example.org','authorized','Autorização sintética')`;
  await db`INSERT INTO question_sources(id,name,publisher,url,rights_status,rights_evidence,rights_scope) VALUES(${srcRemoa},'Remoa sintética QA','Remoa','https://example.org','authorized','Sintética','remoa_owned')`;
  const an=['Área Sintética Alfa','Área Sintética Beta'],tn=[['Assunto Alfa Um','Assunto Alfa Dois','Assunto Alfa Três'],['Assunto Beta Um','Assunto Beta Dois']];
  for(const [a,id] of areas.entries()){await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${id},${id},'area','CM',${an[a]!})`;for(const [k,t] of topics[a]!.entries())await db`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${t},${t},'topic','CM',${tn[a]![k]!},${id})`;}
  for(let i=0;i<60;i++){const id=randomUUID();pub.push(id);const a=i<40?0:1;const t=topics[a]![i%topics[a]!.length]!;
   await insertQ(id,actors.student,i,'user_authored',`Questão sintética ${String(i+1).padStart(2,'0')} sobre formas geométricas (não médica).`,areas[a]!,t);
   await publish(id,i%6===5);}
  await db`INSERT INTO exam_papers(id,source_id,name,institution,year,edition,booklet,status,key_final) VALUES(${paper},${src},'Prova sintética','Instituição Sintética Um','2025','t','A','published',true)`;
  for(const [i,q] of pub.slice(0,20).entries())await db`INSERT INTO exam_question_occurrences(paper_id,question_id,ordinal,original_number) VALUES(${paper},${q},${i+1},${String(i+1)})`;
  for(let i=0;i<4;i++){const id=randomUUID();drafts.push(id);await insertQ(id,actors.other,100+i,'user_authored','Rascunho sintético '+i,areas[0]!,topics[0]![0]!);await db`UPDATE question_bank SET user_id=null,visibility='public',origin='official_exam',source_id=${src},catalog_status='draft' WHERE id=${id}`;}
  privA=randomUUID();privAnotherA=randomUUID();privB=randomUUID();
  await insertQ(privA,actors.student,200,'ai_generated','Pergunta privada IA sintética do aluno A (um)',areas[0]!,topics[0]![0]!);
  await insertQ(privAnotherA,actors.student,201,'ai_generated','Pergunta privada IA sintética do aluno A (dois)',areas[1]!,topics[1]![0]!);
  await insertQ(privB,actors.other,202,'ai_generated','Pergunta privada IA sintética do aluno B',areas[0]!,topics[0]![0]!);
  const {createApp}=await import('../../app');
  const app=createApp({webOrigin:['http://127.0.0.1:'+webPort],verifyToken:fakeVerifier(Object.values(actors))});
  app.use('/__test/*',cors({origin:['http://127.0.0.1:'+webPort]}));
  app.get('/__test/meta',c=>c.json({actors:Object.fromEntries(Object.entries(actors).map(([r,id])=>[r,{id,token:fakeToken(id)}])),areas,topics,pub,drafts,privA,privAnotherA,privB,src}));
  app.post('/__test/sql',async c=>{const {q,p}=await c.req.json() as {q:string;p?:unknown[]};if(!/^\s*select\s/i.test(q))return c.text('select only',400);return c.json(await db.unsafe(q,(p??[]) as never[]));});
  app.post('/__test/flags/:name/:v',c=>{const m:Record<string,string>={bankStudent:'QUESTIONS_BANK_STUDENT_ENABLED',catalog:'QUESTIONS_CATALOG_ENABLED',sessions:'QUESTIONS_SESSIONS_ENABLED',import:'QUESTIONS_IMPORT_ENABLED'};const k=m[c.req.param('name')];if(!k)return c.text('?',400);process.env[k]=c.req.param('v')==='on'?'true':'false';return c.json({ok:true});});
  app.post('/__test/withdraw',async c=>{const {ids}=await c.req.json() as {ids:string[]|'all'};const r=ids==='all'?await db`UPDATE question_bank SET catalog_status='withdrawn' WHERE catalog_status='published' RETURNING id`:await db`UPDATE question_bank SET catalog_status='withdrawn' WHERE id=ANY(${ids}::uuid[]) RETURNING id`;return c.json({n:r.length});});
  app.post('/__test/republish',async c=>{const r=await db`UPDATE question_bank SET catalog_status='published' WHERE id=ANY(${pub}::uuid[]) RETURNING id`;return c.json({n:r.length});});
  app.post('/__test/edit/:id',async c=>{const old=c.req.param('id');const v2=randomUUID();extra.push(v2);
   await db`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin,enamed_area_id,enamed_topic_id,version,canonical_id,supersedes_id) SELECT ${v2},${actors.student},type,difficulty,'Enunciado EDITADO sintético v2',alternatives,'A',expected_answer,source,explanation,'user_authored',enamed_area_id,enamed_topic_id,version+1,coalesce(canonical_id,id),id FROM question_bank WHERE id=${old}`;
   await publish(v2,false);return c.json({v2});});
  app.post('/__test/finish',c=>{setTimeout(()=>release(),50);return c.json({finishing:true});});
  await new Promise<void>((res,rej)=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:apiPort},()=>res());server.once('error',rej);});
 },120000);
 it('serves until finished',async()=>{expect(server.listening).toBe(true);await done;},3600000);
 afterAll(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));});
});
