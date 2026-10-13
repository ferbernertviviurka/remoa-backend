import postgres from 'postgres';
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();process.env.SHARE_SECRET='synthetic-fr32-benchmark-cursor';
const {PgDialect}=await import('drizzle-orm/pg-core');
const {sql}=await import('drizzle-orm');
const A='../../../../../apps/api/src/',C='../../../../../packages/contracts/src/';
const cat=await import(A+'questions/catalog/service.ts'),ed=await import(A+'questions/editorial/catalog.ts'),hist=await import(A+'questions/sessions/history.ts');
const {questionAdminCatalogQuerySchema,questionSessionsPageQuerySchema}=await import(C+'question-admin-catalog.ts');
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}}),s=state(),u=s.users[0].id,d=new PgDialect();
const out={};
async function ex(name,q,role='authenticated',uid=u){const c=d.sqlToQuery(q);
 await db.begin(async tx=>{await tx`SET LOCAL statement_timeout='10s'`;await tx`select set_config('request.jwt.claims',${JSON.stringify({sub:uid,role})},true)`;
  const runs=[];for(let i=0;i<3;i++){const [p]=await tx.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+c.sql,c.params);runs.push(p['QUERY PLAN'][0]);}
  const r=runs[2];out[name]={coldMs:runs[0]['Execution Time'],warmMs:r['Execution Time'],plan:r['Planning Time'],hit:r.Plan['Shared Hit Blocks'],read:r.Plan['Shared Read Blocks'],plan_json:r.Plan};
 });
 process.stdout.write(`${name} ${out[name].coldMs.toFixed(1)} ${out[name].warmMs.toFixed(1)}\n`);}
const [{id:qid}]=await db`select id from question_bank where catalog_status='published' limit 1 offset 777`;
await ex('detail',sql`SELECT ${cat.publicColumns} FROM question_bank q ${cat.catalogJoins(u)} WHERE q.id=${qid} AND ${cat.readable(u)} AND ${cat.latest}`);
const adm=(o)=>ed.catalogPageSQL(questionAdminCatalogQuerySchema.parse(o),null);
await ex('admin_latest',adm({}),'service_role');
await ex('admin_hash_missing',adm({hashState:'missing'}),'service_role');
await ex('admin_hash_present',adm({hashState:'present'}),'service_role');
await ex('admin_hash_present_all',adm({hashState:'present',versions:'all'}),'service_role');
await ex('admin_search',adm({search:'distinctive'}),'service_role');
await ex('admin_status_published',adm({status:'published'}),'service_role');
await ex('admin_status_draft',adm({status:'draft'}),'service_role');
await ex('session_history',hist.sessionHistorySQL(u,questionSessionsPageQuerySchema.parse({}),null).queryChunks?hist.sessionHistorySQL(u,questionSessionsPageQuerySchema.parse({}),null):null);
await ex('capacity_metrics',sql`WITH eligible AS MATERIALIZED
 (SELECT coalesce(q.canonical_id,q.id) canonical,q.origin,q.enamed_area_id area_id,q.enamed_topic_id topic_id FROM question_bank q WHERE q.visibility='public' AND q.availability='active' AND ${cat.readable('00000000-0000-0000-0000-000000000000')} AND ${cat.latest})
 SELECT (SELECT count(DISTINCT canonical)::int FROM eligible) public_canonical,
 (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT origin,count(DISTINCT canonical)::int count FROM eligible GROUP BY origin ORDER BY origin) row) origins,
 (SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM (SELECT e.area_id "areaId",t.name,count(DISTINCT e.canonical)::int count FROM eligible e JOIN enamed_taxonomy t ON t.id=e.area_id GROUP BY e.area_id,t.name ORDER BY t.name,e.area_id LIMIT 501) row) areas`,'authenticated','00000000-0000-0000-0000-000000000000');
save('explain-extra.json',out);await db.end();
