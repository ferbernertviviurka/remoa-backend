import postgres from 'postgres';
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();
const {PgDialect}=await import('drizzle-orm/pg-core');
const {sessionFilterSelectionSQL}=await import('../../../../../apps/api/src/questions/sessions/service.ts');
const {questionListQuerySchema}=await import('../../../../../packages/contracts/src/question-catalog.ts');
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}}),s=state();
try{
 await db`SET statement_timeout='5s'`;
 const query=new PgDialect().sqlToQuery(sessionFilterSelectionSQL(s.users[0].id,questionListQuerySchema.parse({scope:'catalog',sourceId:s.source}),200));
 const [plan]=await db.unsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.params);
 save('explain-create-'+(process.env.F33_EXPLAIN_PHASE??'before-order')+'.json',{synthetic:true,at:new Date().toISOString(),plan:plan['QUERY PLAN']});
 process.stdout.write('Creation selection EXPLAIN saved\n');
}finally{await db.end();}
