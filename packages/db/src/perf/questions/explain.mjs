/** EXPLAIN the exact catalog SQL builder against the isolated synthetic workload. */
import postgres from 'postgres';
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();process.env.SHARE_SECRET='synthetic-fr32-benchmark-cursor';
const {PgDialect}=await import('drizzle-orm/pg-core');
const {catalogListSQL,catalogCountSQL,catalogPageSQL}=await import('../../../../../apps/api/src/questions/catalog/service.ts');
const {questionListQuerySchema}=await import('../../../../../packages/contracts/src/question-catalog.ts');
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}}),s=state(),owner=s.users[0].id,dialect=new PgDialect();
try{
 await db`SET statement_timeout='5s'`;
 const cases={search:{scope:'catalog',sourceId:s.source,search:'distinctive',limit:25},filter:{scope:'catalog',sourceId:s.source,areaId:s.area,difficulty:'medium',limit:25},wrong:{scope:'catalog',sourceId:s.source,state:'wrong',limit:25}};
 const plans={};
 for(const[name,input]of Object.entries(cases)){
  const filter=questionListQuerySchema.parse(input);
  for(const kind of ['list','count','combined']){const query=kind==='list'?catalogListSQL(owner,filter):kind==='count'?catalogCountSQL(owner,filter):catalogPageSQL(owner,filter);
   const compiled=dialect.sqlToQuery(query);try{const [plan]=await db.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+compiled.sql,compiled.params);plans[name+'_'+kind]=plan['QUERY PLAN'];}catch(error){if(error.code!=='57014')throw error;const [estimated]=await db.unsafe('EXPLAIN (FORMAT JSON) '+compiled.sql,compiled.params);plans[name+'_'+kind]={timedOut:true,limitMs:5000,estimated:estimated['QUERY PLAN']};}
   save('explain-'+(process.env.F33_EXPLAIN_PHASE??'before')+'.json',{synthetic:true,at:new Date().toISOString(),plans});}
 }
 save('explain-'+(process.env.F33_EXPLAIN_PHASE??'before')+'.json',{synthetic:true,at:new Date().toISOString(),plans});process.stdout.write('FR32 EXPLAIN saved; no question contents printed\n');
}finally{await db.end();}
