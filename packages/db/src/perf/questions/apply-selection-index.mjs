/** Apply the measured0047 index only to explicit local F33 fixture/perf targets. No default DATABASE_URL. */
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
const ddl=readFileSync(new URL('../../../migrations/0047_f33_question_selection.sql',import.meta.url),'utf8');
if(!/^CREATE INDEX "question_bank_created_id_idx" ON "question_bank" USING btree/.test(ddl))throw Error('unexpected0047DDL');
for(const file of ['/private/tmp/remoa-f33-test-url','/private/tmp/remoa-f33-perf-url']){
 const url=new URL(readFileSync(file,'utf8').trim());
 if(!['127.0.0.1','localhost'].includes(url.hostname)||!['/remoa_f33_test_20261008','/remoa_perf_f33_20261008'].includes(url.pathname))throw Error('explicit local F33 target required');
 const db=postgres(url.toString(),{max:1,onnotice:()=>{}});
 try{await db.unsafe(ddl.replace('CREATE INDEX ','CREATE INDEX IF NOT EXISTS ').replace('CREATE STATISTICS ','CREATE STATISTICS IF NOT EXISTS '));const[index]=await db`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='question_bank' AND indexname='question_bank_created_id_idx'`;if(!index||!index.indexdef.includes('created_at DESC')||!index.indexdef.includes('id DESC'))throw Error('wrong ordering index');const[stats]=await db`SELECT count(*)::int n FROM pg_statistic_ext WHERE stxname='question_bank_review_match_stats' AND stxrelid='public.question_bank'::regclass`;if(stats.n!==1)throw Error('review expression statistics missing');process.stdout.write('0047 isolated target ready:'+url.pathname.slice(1)+'\n');}finally{await db.end();}
}
