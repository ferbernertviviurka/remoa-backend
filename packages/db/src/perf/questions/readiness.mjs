/** Verify workload shape without disabling triggers, reading question content or contacting external services. */
import postgres from 'postgres';
import {targetUrl,save} from './target.mjs';
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}});
try{
 const [shape]=await db`SELECT
  (SELECT count(*)::int FROM question_bank WHERE visibility='public' AND catalog_status='published') canonical,
  (SELECT count(DISTINCT coalesce(canonical_id,id))::int FROM question_bank WHERE visibility='public' AND catalog_status='published') unique_canonical,
  (SELECT count(*)::int FROM question_bank WHERE canonical_id IS NULL) null_canonical,
  (SELECT count(*)::int FROM question_bank WHERE version>1) versions,
  (SELECT count(*)::int FROM question_answers) attempts,
  current_setting('session_replication_role') trigger_mode,pg_size_pretty(pg_database_size(current_database())) db_size`;
 const triggers=await db`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='question_bank'::regclass AND NOT tgisinternal ORDER BY tgname`;
 if(shape.canonical!==50000||shape.unique_canonical!==50000||shape.null_canonical!==0||shape.versions!==5000||shape.attempts<100000||shape.trigger_mode!=='origin'||triggers.some(t=>t.tgenabled!=='O'))throw Error('synthetic FR32 workload shape mismatch');
 save('readiness.json',{synthetic:true,at:new Date().toISOString(),shape,triggers});process.stdout.write('FR32 readiness:50000 canonical,5000 draft versions,at least100000 attempts; triggers enabled\n');
}finally{await db.end();}
