/** Cold application pool, then warm simultaneous initial-screen requests. Uses the actual HTTP handlers and5s timeout. */
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {afterAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {writeFile} from 'node:fs/promises';
import type {Env} from '../../app';
const enabled=process.env.G29_RELIABILITY_SQL_TEST==='1'&&!!process.env.DATABASE_URL;
if(enabled){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/remoa_g29_reliability_f33_test_20261019')throw Error('disposable_reliability_clone_required');}
describe.skipIf(!enabled)('G29 authorized catalog initial-screen concurrency',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('serves default25 and both disjunctive facet queries simultaneously with cold and warm prepared connections',async()=>{
 process.env.QUESTIONS_BANK_STUDENT_ENABLED='true';process.env.SHARE_SECRET='synthetic-reliability-cursor';
 const{db}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});
 const[fixture]=await db.execute<{user_id:string;q:number;s:number}>(sql`SELECT (SELECT user_id FROM profiles LIMIT 1) user_id,(SELECT count(*)::int FROM question_bank) q,(SELECT count(*)::int FROM question_sources WHERE rights_status='authorized') s`);expect(fixture!.q).toBeGreaterThan(38000);expect(fixture!.s).toBe(841);
 const owner=randomUUID(),foreign=randomUUID();await db.execute(sql`INSERT INTO auth.users(id,email) VALUES(${owner},${owner+'@example.invalid'}),(${foreign},${foreign+'@example.invalid'})`);
 for(let i=0;i<15;i++)await db.execute(sql`INSERT INTO question_bank(user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,origin,created_at) VALUES(${i<14?owner:foreign},'objective','medium','Synthetic private reliability question','[{"key":"A","text":"One"},{"key":"B","text":"Two"}]'::jsonb,'A','Synthetic','student','user_authored',now()+interval '1 day')`);
 try{
 // The only setup connection above is deliberately occupied while3new physical connections prepare the actual catalog queries.
 const{questionsRoutes}=await import('../../routes/questions');const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('userId',owner);await next();});app.route('/v1/questions',questionsRoutes());
 const paths=['?limit=25','/facets?groups=difficulty','/facets?groups=institution%2Cyear%2Cdifficulty'];const receipt:unknown[]=[];
 const phase=async(name:string)=>{const results=await Promise.all(paths.map(async path=>{const t=performance.now(),r=await app.request('/v1/questions'+path),body=await r.json();expect(r.status).toBe(200);expect(body.ok).toBe(true);expect(JSON.stringify(body)).not.toMatch(/"(?:correctKey|correct_key|expectedAnswer|explanation)"/);return {path,status:r.status,ms:Math.round(performance.now()-t),data:body.data};}));
 expect(results[0]!.data.items).toHaveLength(25);expect(results[0]!.data.items.filter((q:{visibility:string})=>q.visibility==='private')).toHaveLength(14);expect(results[0]!.data.total).toBe(28202);expect(results[0]!.data.nextCursor).toBeTruthy();for(const r of results)expect(r.ms).toBeLessThan(5000);
 receipt.push({phase:name,results:results.map(({data,...meta})=>({...meta,total:data.total??null}))});return results;};
 await db.transaction(async tx=>{await tx.execute(sql`SELECT 1`);await phase('cold_prepared_pool');});
 const warm=await phase('warm_concurrent');await phase('warm_repeat_concurrent');
 const cursor=warm[0]!.data.nextCursor;const next=await app.request('/v1/questions?limit=25&cursor='+encodeURIComponent(cursor));expect(next.status).toBe(200);const body=await next.json();expect(new Set([...warm[0]!.data.items,...body.data.items].map((q:{id:string})=>q.id)).size).toBe(50);
 await writeFile('/tmp/g29-reliability-http-receipt.json',JSON.stringify({productionWrites:0,localOnly:true,cacheCold:false,workload:'authorized841,28188public,9974drafts,14ownerprivate,1foreignprivate',receipt},null,2));
 }finally{await db.execute(sql`DELETE FROM auth.users WHERE id IN(${owner},${foreign})`);}
 },120000);
});
