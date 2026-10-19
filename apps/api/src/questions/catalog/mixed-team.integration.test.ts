/** Regression for the exact default GET /v1/questions?limit=25 path. Explicit disposable full-corpus DB only. */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import type { Env } from '../../app';
import { questionListResultSchema } from '@remoa/contracts';
const fixture=vi.hoisted(()=>({tx:null as Tx|null}));
vi.mock('../../db',async importOriginal=>({...await importOriginal<typeof import('../../db')>(),run:async(_user:string,fn:(tx:Tx)=>Promise<unknown>)=>{if(!fixture.tx)throw Error('test_transaction_required');return fn(fixture.tx);}}));
vi.mock('../../storage/storage',()=>({presignGet:vi.fn(async()=> 'https://example.invalid/original'),getBytes:vi.fn(),putBytes:vi.fn(),headObject:vi.fn(),deleteObject:vi.fn()}));
const url=process.env.DATABASE_URL,enabled=process.env.G29_CATALOG_SQL_TEST==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/remoa_g29_full_test_20261019')throw Error('disposable_full_corpus_required');}
describe.skipIf(!enabled)('mixed signed-team and private catalog',()=>{
 let end:(()=>Promise<void>)|undefined;
 afterAll(async()=>{await end?.();});
 it('lists25 without scope/course, paginates without duplicates, filters owners and preserves signed visibility parity',async()=>{
  process.env.SHARE_SECRET='synthetic-catalog-cursor';process.env.QUESTIONS_BANK_STUDENT_ENABLED='true';
  const {db}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});
  const {asServer}=await import('../../db'),{teamReadable}=await import('./service'),{questionsRoutes}=await import('../../routes/questions');
  const owner=randomUUID(),foreign=randomUUID(),area=randomUUID(),topic=randomUUID();
  try{await db.transaction(async tx=>{
   fixture.tx=tx;
   await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${owner},${owner+'@example.invalid'}),(${foreign},${foreign+'@example.invalid'})`);
   await tx.execute(sql`INSERT INTO enamed_taxonomy(id,code,kind,area,name) VALUES(${area},${area},'area','CM','Synthetic area')`);
   await tx.execute(sql`INSERT INTO enamed_taxonomy(id,code,kind,area,name,parent_id) VALUES(${topic},${topic},'topic','CM','Synthetic topic',${area})`);
   const privateIds:string[]=[];
   for(let i=0;i<15;i++){
    const id=randomUUID();if(i<14)privateIds.push(id);
    await tx.execute(sql`INSERT INTO question_bank(id,user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,origin,created_at,enamed_area_id,enamed_topic_id)
     VALUES(${id},${i<14?owner:foreign},'objective','medium','Synthetic private question','[{"key":"A","text":"One"},{"key":"B","text":"Two"}]'::jsonb,'B','Two','student','user_authored',now()+interval '1 day'+${i}*interval '1 second',${i%2?area:null},${i%2?topic:null})`);
   }
   const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('userId',owner);await next();});app.route('/v1/questions',questionsRoutes());
   const request=async(query:string)=>{
    const response=await app.request('/v1/questions?'+query);expect(response.status).toBe(200);
    const body=await response.json() as {data:unknown};const leaks:string[]=[];const scan=(value:unknown)=>{if(Array.isArray(value))value.forEach(scan);else if(value&&typeof value==='object')for(const [key,nested]of Object.entries(value)){if(['correctKey','correct_key','explanation','distractorNotes','expectedAnswer'].includes(key))leaks.push(key);scan(nested);}};scan(body);expect(leaks).toEqual([]);
    return questionListResultSchema.parse(body.data);
   };
   const first=await request('limit=25');expect(first.items).toHaveLength(25);expect(first.total).toBe(28202);expect(first.nextCursor).toBeTruthy();
   expect(first.items.filter(q=>q.visibility==='private')).toHaveLength(14);expect(first.items.some(q=>q.topicId===topic)).toBe(true);expect(first.items.some(q=>q.topicId===null)).toBe(true);
   const second=await request('limit=25&cursor='+encodeURIComponent(first.nextCursor!));expect(second.items).toHaveLength(25);expect(second.total).toBe(first.total);expect(new Set([...first.items,...second.items].map(q=>q.id)).size).toBe(50);
   const mine=await request('limit=25&scope=mine');expect(new Set(mine.items.map(q=>q.id))).toEqual(new Set(privateIds));
   const catalog=await request('limit=25&scope=catalog');expect(catalog.total).toBe(28188);expect(catalog.items).toHaveLength(25);
   const [parity]=await asServer<{mismatches:number}>(tx,sql`SELECT count(*)::int mismatches FROM question_bank q WHERE coalesce((${teamReadable}),false) IS DISTINCT FROM public.f33_team_question_visible(q.id,q.content_hash)`);expect(parity?.mismatches).toBe(0);
   const [counts]=await asServer<{tagged:number;unclassified:number}>(tx,sql`SELECT count(*) FILTER(WHERE jsonb_array_length(original_payload->'areas')>0)::int tagged,count(*) FILTER(WHERE coalesce(jsonb_array_length(original_payload->'areas'),0)=0)::int unclassified FROM question_team_items`);expect(counts).toEqual({tagged:634,unclassified:27554});
   throw Error('synthetic_fixture_rollback');
  });}catch(error){if(!(error instanceof Error)||error.message!=='synthetic_fixture_rollback')throw error;}finally{fixture.tx=null;}
 },120000);
});
