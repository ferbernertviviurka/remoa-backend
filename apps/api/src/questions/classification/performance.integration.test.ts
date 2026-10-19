/** Read-only cold prepared-pool and simultaneous initial-screen queries against the already seeded isolated live clone. */
import {readFile,writeFile} from 'node:fs/promises';
import {afterAll,describe,expect,it} from 'vitest';
import {Hono} from 'hono';
import {sql} from 'drizzle-orm';
import type {Env} from '../../app';
import {questionListQuerySchema,questionFacetQuerySchema} from '@remoa/contracts';
const enabled=process.env.G29_CLASSIFICATION_PERF_TEST==='1'&&!!process.env.DATABASE_URL;
if(enabled){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/remoa_g29_classification_live_f33_test_20261019')throw Error('isolated_seeded_live_clone_required');}
describe.skipIf(!enabled)('G29 live automatic taxonomy initial-screen performance',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('serves4concurrent requests cold and warm within unchanged5s timeout, with bounded1209binding InitPlans',async()=>{
 process.env.QUESTIONS_BANK_STUDENT_ENABLED='true';process.env.SHARE_SECRET='synthetic-classification-perf';
 const fixture=JSON.parse(await readFile('/tmp/g29-classification-live-fixture.json','utf8')) as {owner:string};
 const{db}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});
 const[guard]=await db.execute<{bindings:number;nodes:number;jit:string;work_mem:string}>(sql`SELECT (SELECT count(*)::int FROM question_classification_bindings) bindings,(SELECT count(*)::int FROM question_classification_nodes) nodes,current_setting('jit') jit,current_setting('work_mem') work_mem`);expect(guard?.bindings).toBe(1209);expect(guard?.nodes).toBe(119);expect(guard?.jit).toBe('off');
 const{questionsRoutes}=await import('../../routes/questions');const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('userId',fixture.owner);await next();});app.route('/v1/questions',questionsRoutes());
 const paths=['?limit=25','/facets?groups=difficulty','/facets?groups=institution%2Cyear%2Cdifficulty','/classification?course=medicine'];const phases:unknown[]=[];
 for(const phase of ['cold_prepared_pool','warm_concurrent','warm_repeat']){
 const results=await Promise.all(paths.map(async path=>{const started=performance.now(),r=await app.request('/v1/questions'+path),body=await r.json();expect(r.status).toBe(200);expect(body.ok).toBe(true);expect(JSON.stringify(body)).not.toMatch(/"(?:correctKey|correct_key|explanation|expectedAnswer)"/);const ms=Math.round(performance.now()-started);expect(ms).toBeLessThan(5000);return{path,status:r.status,ms,total:body.data.total};}));
 expect(results.slice(0,3).every(r=>r.total===28228)).toBe(true);expect(results[3]!.total).toBe(17760);phases.push({phase,results});
 }
 const{catalogPageSQL}=await import('../catalog/service'),{questionFacetSQL}=await import('../catalog/facets'),{classificationCatalogSQL}=await import('./catalog');
 const queries=[['list',catalogPageSQL(fixture.owner,questionListQuerySchema.parse({limit:25}),null,true)],['facets3',questionFacetSQL(fixture.owner,questionFacetQuerySchema.parse({groups:['institution','year','difficulty']}))],['classification',classificationCatalogSQL(fixture.owner,'medicine')]] as const;
 const plans:Record<string,unknown>={};
 for(const[name,query]of queries){const[raw]=await db.execute<Record<string,unknown>>(sql`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${query}`);const plan=(raw!['QUERY PLAN'] as {Plan:Record<string,unknown>; 'Execution Time':number}[])[0]!;let bindingScans=0,maxBindingLoops=0;
 const walk=(node:Record<string,unknown>)=>{if(node['Relation Name']==='question_classification_bindings'){bindingScans++;maxBindingLoops=Math.max(maxBindingLoops,Number(node['Actual Loops']));}for(const child of(node.Plans??[])as Record<string,unknown>[])walk(child);};walk(plan.Plan);expect(bindingScans).toBeGreaterThan(0);expect(maxBindingLoops).toBe(1);plans[name]={executionMs:plan['Execution Time'],bindingScans,maxBindingLoops};await writeFile('/tmp/g29-classification-plan-'+name+'.json',JSON.stringify(plan));}
 await writeFile('/tmp/g29-classification-performance-receipt.json',JSON.stringify({localOnly:true,productionWrites:0,physicalPostgresCacheCold:false,statementTimeoutMs:5000,guard,phases,plans},null,2));
 },120000);
});
