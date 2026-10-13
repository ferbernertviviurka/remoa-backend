/** CCR-149 / D-1833: before/after EXPLAIN of the F34 + catalog list statements, the `latest` self anti-join vs question_superseded (0056).
 * Captures the app's SQL as issued, then EXPLAINs each statement as-is (before) and with `latest` rewritten (after), interleaved, median of 3. */
import postgres from 'postgres';
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();process.env.SHARE_SECRET='synthetic-fr32-benchmark-cursor';process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';
const {PgDialect}=await import('drizzle-orm/pg-core');let cap=null;
{const o=PgDialect.prototype.sqlToQuery;PgDialect.prototype.sqlToQuery=function(...a){const r=o.apply(this,a);if(cap&&r.sql.length>400)cap.push(r);return r;};}
const {examBuilder}=await import('../../../../../apps/api/src/questions/builder/service.ts');
const {questionFacets}=await import('../../../../../apps/api/src/questions/catalog/facets.ts');
const {catalogPageSQL}=await import('../../../../../apps/api/src/questions/catalog/service.ts');
const C=await import('../../../../../packages/contracts/src/index.ts');
const s=state(),owner=s.users[0].id,A=s.area,dialect=new PgDialect();
const params=count=>({count,mode:'study',source:'catalog',areaIds:[A],difficulties:['medium','easy','hard'],progress:'all',distribution:'balanced'});
const cases={
 facets:()=>questionFacets(owner,C.questionFacetQuerySchema.parse({scope:'catalog',sourceId:s.source,areaIds:[A],difficulties:['easy','medium'],groups:'area,topic,institution,year,difficulty'})),
 availability:()=>examBuilder.availability(owner,C.examBuilderFilterSchema.parse({source:'catalog',areaIds:[A],difficulties:['easy','medium'],progress:'all'})),
 preview40:()=>examBuilder.preview(owner,C.examPreviewInputSchema.parse({params:params(40),seed:'a'.repeat(32)})),
 preview100:()=>examBuilder.preview(owner,C.examPreviewInputSchema.parse({params:params(100),seed:'a'.repeat(32)})),
 list:async()=>{cap.push(dialect.sqlToQuery(catalogPageSQL(owner,C.questionListQuerySchema.parse({scope:'catalog',sourceId:s.source,limit:25}))));},
 listFiltered:async()=>{cap.push(dialect.sqlToQuery(catalogPageSQL(owner,C.questionListQuerySchema.parse({scope:'catalog',sourceId:s.source,areaId:A,difficulty:'medium',limit:25}))));},
};
const LATEST=/NOT EXISTS \(SELECT 1 FROM question_bank newer WHERE coalesce\(newer\.canonical_id,newer\.id\) = coalesce\((\w+)\.canonical_id,\1\.id\)[\s\S]*?newer\.catalog_status='published'\)\)\)\)/g;
const after=q=>q.replace(LATEST,(_,a)=>`NOT EXISTS (SELECT 1 FROM question_superseded s WHERE s.question_id=${a}.id)`);
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}});const out={};
const explain=async(text,p)=>{const [{['QUERY PLAN']:plan}]=await db.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+text.replace(/\$(\d+)::jsonb/g,'$$$1::text::jsonb'),p??[]);return plan[0];};
const med=xs=>xs.sort((a,b)=>a-b)[xs.length>>1];
try{for(const[name,fn]of Object.entries(cases)){cap=[];await fn();const list=cap;cap=null;out[name]=[];
 for(const q of list){const rewritten=after(q.sql),b=[],a=[];let planAfter;
  for(let i=0;i<3;i++){b.push((await explain(q.sql,q.params))['Execution Time']);planAfter=await explain(rewritten,q.params);a.push(planAfter['Execution Time']);}
  out[name].push({latestUses:(q.sql.match(LATEST)??[]).length,beforeMs:med(b),afterMs:med(a),planAfter});}}
 save('explain-latest-f34.json',{synthetic:true,at:new Date().toISOString(),out});
 for(const[n,st]of Object.entries(out))process.stdout.write(n+' '+st.map(x=>`[uses=${x.latestUses} ${x.beforeMs.toFixed(1)}→${x.afterMs.toFixed(1)}ms]`).join(' ')+'\n');
}finally{await db.end();process.exit(0);}
