/** Measured expression statistics experiment, exclusively on the guarded synthetic perf target. */
import postgres from 'postgres';
import {targetUrl,save} from './target.mjs';
const db=postgres(targetUrl(),{max:1,onnotice:()=>{}});
try{
 await db`CREATE STATISTICS IF NOT EXISTS question_bank_review_match_stats ON (reviewed_hash=content_hash) FROM public.question_bank`;
 await db`ANALYZE public.question_bank`;
 const distribution=await db`SELECT reviewed_hash=content_hash matches,count(*)::int n FROM question_bank GROUP BY reviewed_hash=content_hash`;
 save('review-statistics.json',{synthetic:true,at:new Date().toISOString(),distribution});
 process.stdout.write('Perf-only review expression statistics analyzed\n');
}finally{await db.end();}
