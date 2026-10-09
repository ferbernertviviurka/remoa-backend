/** TEST ONLY: actual Hono handlers + isolated PostgreSQL, fake local JWT verifier + in-memory private storage. */
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {cors} from 'hono/cors';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {fakeToken,fakeVerifier} from '../../admin/core/test-helpers';
import {syntheticExamPdf} from './synthetic-exam';
import {syntheticPdf} from '../../../../../packages/ai/eval/model/synthetic-pdf';
import type {z} from 'zod';
const provider=vi.hoisted(()=>({gradeCalls:0,forbiddenCalls:0,finalNegationSeen:false}));
vi.mock('@remoa/ai',async original=>({...await original<typeof import('@remoa/ai')>(),generateJson:vi.fn(async(schema:z.ZodType,options:{fn:string;system:string})=>{
 if(options.fn!=='grade'){provider.forbiddenCalls++;throw Error('TEST_ONLY_PROVIDER_GENERATION_FORBIDDEN');}
 provider.gradeCalls++;provider.finalNegationSeen=options.system.includes('NEGACAO_FINAL: NÃO conclua que os tamanhos são iguais.');
 const data=schema.parse({veredito:'parcial',pontos_cobertos:['Observação sintética'],pontos_faltantes:['Comparação sintética'],contradicoes:[],mesmo_contexto:true,erro_critico:false,tentativa_de_manipulacao:false,feedback:'Feedback sintético de teste: confira a conclusão.',dica:null,confianca:.9});
 return{data,text:JSON.stringify(data),model:'test-only-grade-stub',latencyMs:0,repaired:false};
}),generateText:vi.fn(async()=>{provider.forbiddenCalls++;throw Error('TEST_ONLY_PROVIDER_GENERATION_FORBIDDEN');}),streamText:vi.fn(()=>{provider.forbiddenCalls++;throw Error('TEST_ONLY_PROVIDER_GENERATION_FORBIDDEN');})}));
const objects=new Map<string,Buffer>();const tickets=new Map<string,string>();const base='http://127.0.0.1:4341';
vi.mock('../../storage/storage',()=>({putBytes:vi.fn(async(k:string,b:Buffer)=>{objects.set(k,b);}),getBytes:vi.fn(async(k:string)=>{const b=objects.get(k);if(!b)throw Error('missing_test_object');return b;}),deleteObject:vi.fn(async(k:string)=>{objects.delete(k);}),headObject:vi.fn(async(k:string)=>{const bytes=objects.get(k);return bytes?{size:bytes.length,mime:k.endsWith('.png')?'image/png':'application/pdf'}:null;}),presignGet:vi.fn(async(k:string)=>{const ticket=randomUUID();tickets.set(ticket,k);return base+'/__test/objects/'+ticket;})}));
vi.mock('../../cache',()=>({invalidate:vi.fn(async()=>{})}));
vi.mock('../../inngest/client',async original=>({...await original<typeof import('../../inngest/client')>(),dispatchQuestionImport:vi.fn(async()=>false)}));
describe.skipIf(process.env.F33_HTTP_HARNESS!=='1')('test-only HTTP integration server',()=>{

const run=randomUUID();const actors={admin:randomUUID(),reviewer:randomUUID(),student:randomUUID(),other:randomUUID()};const area=randomUUID(),topic=randomUUID(),privateQuestion=randomUUID(),privateDiscursive=randomUUID(),discursiveBoard=randomUUID();
const discursiveStem='Questão discursiva HTTP sintética sobre formas. '+('Contexto sintético: observe os círculos e suas relações. '.repeat(110))+'NEGACAO_FINAL: NÃO conclua que os tamanhos são iguais.';
let db:typeof import('@remoa/db');let server:ReturnType<typeof serve>;let release:()=>void;const done=new Promise<void>(resolve=>{release=resolve;});let sourceIds:string[]=[];
let app:ReturnType<typeof import('../../app').createApp>;
const reason='Rodada HTTP sintética não médica '+run;
beforeAll(async()=>{
 const raw=process.env.DATABASE_URL;if(process.env.NODE_ENV!=='test'||!raw)throw Error('Requires explicit test environment and isolated URL');const parsed=new URL(raw);if(!['/f33_test','/remoa_f33_test_20261008'].includes(parsed.pathname)||!['localhost','127.0.0.1'].includes(parsed.hostname))throw Error('Refusing nonisolated database');
 db=await import('@remoa/db');
 for(const id of Object.values(actors))await db.db.$client`INSERT INTO auth.users(id,email) VALUES(${id},${id+'@f33-http.example'})`;
 await db.db.$client`UPDATE profiles SET role='admin',name='Administrador sintético HTTP' WHERE user_id=${actors.admin}`;
 await db.db.$client`UPDATE profiles SET role='reviewer',name='Revisor sintético HTTP',crm='12345-SP' WHERE user_id=${actors.reviewer}`;
 await db.db.$client`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM',${'Área HTTP sintética '+run})`;
 await db.db.$client`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM',${'Assunto HTTP sintético '+run},${area})`;
 await db.db.$client`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,explanation,origin) VALUES(${privateQuestion},${actors.student},'objective','medium','Questão privada HTTP sintética sobre formas',${JSON.stringify([{key:'A',text:'Primeira forma'},{key:'B',text:'Segunda forma'}])}::text::jsonb,'A','Primeira forma','student','Comentário HTTP sintético','user_authored')`;
 await db.db.$client`INSERT INTO boards(id,user_id,title) VALUES(${discursiveBoard},${actors.student},'Mapa HTTP sintético sem cards')`;
 await db.db.$client`INSERT INTO question_bank(id,user_id,board_id,type,difficulty,stem,expected_answer,key_points,source,origin,visibility,card_ids,enamed_area_id,enamed_topic_id) VALUES(${privateDiscursive},${actors.student},${discursiveBoard},'discursive','medium',${discursiveStem},'HIDDEN_DISC_HARNESS_REFERENCE compare os tamanhos sem concluir igualdade.',ARRAY['Comparar tamanhos sintéticos'],'ai','ai_generated','private',ARRAY[]::uuid[],${area},${topic})`;
 const{createApp}=await import('../../app');app=createApp({webOrigin:['http://127.0.0.1:4318',base],verifyToken:fakeVerifier(Object.values(actors))});
 app.use('/__test/*',cors({origin:['http://127.0.0.1:4318',base]}));
 // These routes exist exclusively in this test entry, never in createApp or production routes.
 app.get('/__test/meta',c=>c.json({run,actors:Object.fromEntries(Object.entries(actors).map(([role,id])=>[role,{id,token:fakeToken(id)}])),area,topic,privateQuestion,privateDiscursive,discursiveBoard,discursiveStem,reason}));
 app.get('/__test/provider',c=>c.json({...provider,kind:'Test-only AI provider stub; actual F32 grader and PostgreSQL attempts'}));
 app.get('/__test/discursive-state/:id',async c=>{
  const items=await db.db.$client`SELECT bank_id,card_id FROM challenge_items WHERE session_id=${c.req.param('id')} AND user_id=${actors.student}`;
  const [cards]=await db.db.$client`SELECT count(*)::int n FROM cards WHERE board_id=${discursiveBoard}`;
  const [attempts]=await db.db.$client`SELECT count(*)::int n FROM challenge_attempts WHERE user_id=${actors.student} AND item_id IN (SELECT id FROM challenge_items WHERE session_id=${c.req.param('id')} AND user_id=${actors.student})`;
  const [usage]=await db.db.$client`SELECT coalesce(sum(ai_grades),0)::int grades,coalesce(sum(ai_generations),0)::int generations,coalesce(sum(ai_question_batches),0)::int batches FROM usage_counters WHERE user_id=${actors.student}`;
  return c.json({bankIds:items.map(row=>row.bank_id),cardIds:items.map(row=>row.card_id),boardCards:Number(cards?.n??0),attempts:Number(attempts?.n??0),usage:{grades:Number(usage?.grades??0),generations:Number(usage?.generations??0),batches:Number(usage?.batches??0)}});
 });
 app.get('/__test/pdf/:kind',c=>{const lines=c.req.param('kind')==='answer_key'?['GABARITO DEFINITIVO SINTETICO PARA TESTE ISOLADO HTTP','PROVA A','1 A']:['Questão 1','Enunciado sintetico nao medico sobre formas','A) Primeira forma sintetica','B) Segunda forma sintetica'];return new Response(new Uint8Array(c.req.param('kind')==='exam'?syntheticExamPdf():syntheticPdf(lines.map(line=>line.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)')))).buffer,{headers:{'content-type':'application/pdf'}});});
 app.get('/__test/objects/:ticket',c=>{const key=tickets.get(c.req.param('ticket'));const data=key&&objects.get(key);if(!data)return c.text('Missing synthetic object',404);return new Response(new Uint8Array(data).buffer,{headers:{'content-type':key.endsWith('.png')?'image/png':'application/pdf','cache-control':'no-store'}});});
 app.post('/__test/process/:id',async c=>{const id=c.req.param('id');const rows=await db.db.$client`SELECT id FROM question_imports WHERE id=${id} AND user_id=${actors.admin}`;if(!rows.length)return c.text('Not owned by harness',404);const{runStoredQuestionImport}=await import('../imports/store');return c.json(await runStoredQuestionImport(id));});
 app.post('/__test/expire/:id',async c=>{const rows=await db.db.$client`UPDATE question_sessions SET deadline=clock_timestamp()-interval '1 second' WHERE id=${c.req.param('id')} AND user_id=${actors.student} RETURNING id`;return c.json({expired:rows.length===1});});
 app.post('/__test/flags/:mode',c=>{for(const name of ['QUESTIONS_IMPORT_ENABLED','QUESTIONS_CATALOG_ENABLED','QUESTIONS_SESSIONS_ENABLED'])delete process.env[name];const on=c.req.param('mode')!=='off';process.env.QUESTIONS_IMPORT_ENABLED=String(on);process.env.QUESTIONS_CATALOG_ENABLED=String(on);process.env.QUESTIONS_SESSIONS_ENABLED=String(on);return c.json({changed:true});});
 app.post('/__test/finish',c=>{setTimeout(()=>release(),50);return c.json({finishing:true});});
 await new Promise<void>((resolve,reject)=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:4341},()=>resolve());server.once('error',reject);});
},60000);
it('serves actual F33 HTTP handlers until the browser finishes',async()=>{expect(server.listening).toBe(true);await done;},3600000);
afterAll(async()=>{
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 if(!db)return;
 const owned=await db.db.$client`SELECT id FROM question_sources WHERE id IN (SELECT source_id FROM question_documents WHERE user_id=${actors.admin}) OR created_at >= (SELECT created_at FROM profiles WHERE user_id=${actors.admin}) AND name LIKE ${'F33 HTTP '+run+'%'}`;sourceIds=owned.map(row=>row.id as string);
 await db.db.$client`DELETE FROM question_sessions WHERE user_id IN (${actors.student},${actors.other},${actors.admin},${actors.reviewer})`;
 await db.db.$client`DELETE FROM challenge_sessions WHERE user_id IN (${actors.student},${actors.other},${actors.admin},${actors.reviewer})`;
 for(const source of sourceIds){await db.db.$client`DELETE FROM question_imports WHERE source_id=${source}`;await db.db.$client`DELETE FROM exam_papers WHERE source_id=${source}`;await db.db.$client`DELETE FROM question_bank WHERE source_id=${source}`;}
 await db.db.$client`DELETE FROM question_bank WHERE id=${privateQuestion}`;
 await db.db.$client`DELETE FROM question_bank WHERE id=${privateDiscursive}`;
 await db.db.$client`DELETE FROM boards WHERE id=${discursiveBoard}`;
 await db.db.$client`DELETE FROM question_documents WHERE user_id=${actors.admin}`;
 for(const source of sourceIds)await db.db.$client`DELETE FROM question_sources WHERE id=${source}`;
 await db.db.$client`DELETE FROM enamed_taxonomy WHERE id=${topic}`;await db.db.$client`DELETE FROM enamed_taxonomy WHERE id=${area}`;
 await db.db.$client`DELETE FROM auth.users WHERE id IN (${actors.admin},${actors.reviewer},${actors.student},${actors.other})`;
 objects.clear();tickets.clear();
},30000);

});
