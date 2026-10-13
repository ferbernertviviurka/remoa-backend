/** F34 EXPLAIN (ANALYZE, BUFFERS) of the facets / availability / preview statements as the app issues them (captured at the postgres-js session). Superuser, so no RLS. */
import postgres from 'postgres';
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();process.env.SHARE_SECRET='synthetic-fr32-benchmark-cursor';process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';
const {examBuilder}=await import('../../../../../apps/api/src/questions/builder/service.ts');
const {questionFacets}=await import('../../../../../apps/api/src/questions/catalog/facets.ts');
const {examBuilderFilterSchema,examPreviewInputSchema}=await import('../../../../../packages/contracts/src/index.ts');const {questionFacetQuerySchema}=await import('../../../../../packages/contracts/src/index.ts');
const s=state(),owner=s.users[0].id,A=s.area;let cap=null;
{const {PgDialect}=await import('drizzle-orm/pg-core');const o=PgDialect.prototype.sqlToQuery;PgDialect.prototype.sqlToQuery=function(...a){const r=o.apply(this,a);if(cap&&r.sql.length>400)cap.push({sql:r.sql,params:r.params});return r;};}
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}});const plans={};
const params=count=>({count,mode:'study',source:'catalog',areaIds:[A],difficulties:['medium','easy','hard'],progress:'all',distribution:'balanced'});
const cases={
 facets:()=>questionFacets(owner,questionFacetQuerySchema.parse({scope:'catalog',sourceId:s.source,areaIds:[A],difficulties:['easy','medium'],groups:'area,topic,institution,year,difficulty'})),
 availability:()=>examBuilder.availability(owner,examBuilderFilterSchema.parse({source:'catalog',areaIds:[A],difficulties:['easy','medium'],progress:'all'})),
 preview40:()=>examBuilder.preview(owner,examPreviewInputSchema.parse({params:params(40),seed:'a'.repeat(32)})),
 preview100:()=>examBuilder.preview(owner,examPreviewInputSchema.parse({params:params(100),seed:'a'.repeat(32)})),
};
try{for(const[name,fn]of Object.entries(cases)){cap=[];const t0=performance.now();await fn();const wall=performance.now()-t0;const list=cap;cap=null;plans[name]={wallMs:Math.round(wall),statements:[]};
 for(const q of list){let plan;try{[{['QUERY PLAN']:plan}]=await db.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+q.sql.replace(/\$(\d+)::jsonb/g,'$$$1::text::jsonb'),q.params??[]);}catch(e){plan={error:e.message};}
  plans[name].statements.push({executionMs:plan[0]?.['Execution Time'],planningMs:plan[0]?.['Planning Time'],plan});}}
 save('explain-f34.json',{synthetic:true,at:new Date().toISOString(),plans});
 for(const[n,p]of Object.entries(plans))process.stdout.write(n+' stmts='+p.statements.length+' exec='+p.statements.map(x=>x.executionMs).join(',')+' plan='+p.statements.map(x=>x.planningMs).join(',')+'\n');
}finally{await db.end();process.exit(0);}
