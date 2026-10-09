/** Completes known missing legacy objects on the explicitly isolated F33 fixture DB.
 * Does not load .env or touch production/shared DBs. Apply0041–0045 normally first.
 * Supabase's default ACLs are absent from our schema-only fixture, so mirror only
 * the legacy owner policies' intended grants; F33 secret table grants stay revoked.
 */
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
const target=process.env.TEST_DATABASE_URL;
if(!target||!new URL(target).pathname.includes('f33_test'))throw Error('TEST_DATABASE_URL must explicitly name an isolated f33_test DB');
const db=postgres(target,{max:1,onnotice:()=>{}});
const dir=fileURLToPath(new URL('../../migrations/',import.meta.url));
try{
 for(const prefix of['0036','0037','0038','0039','0040']){
  const file=readdirSync(dir).find(name=>name.startsWith(prefix)&&name.endsWith('.sql'));if(!file)throw Error('missing existing migration');
  for(let stmt of readFileSync(dir+file,'utf8').split('--> statement-breakpoint')){
   stmt=stmt.replace(/^--.*$/gm,'').trim();if(!stmt)continue;
   const table=stmt.match(/^CREATE TABLE "([^"]+)"/);if(table){const [r]=await db`SELECT to_regclass(${'public.'+table[1]}) t`;if(r?.t)continue;}
   const constraint=stmt.match(/ADD CONSTRAINT "([^"]+)"/);if(constraint){const [r]=await db`SELECT 1 FROM pg_constraint WHERE conname=${constraint[1]!}`;if(r)continue;}
   const policy=stmt.match(/^CREATE POLICY (\w+) ON public\.(\w+)/);if(policy){const [r]=await db`SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=${policy[2]!} AND policyname=${policy[1]!}`;if(r)continue;}
   stmt=stmt.replace('ADD VALUE','ADD VALUE IF NOT EXISTS').replace('ADD COLUMN','ADD COLUMN IF NOT EXISTS').replace(/^CREATE (UNIQUE )?INDEX /,(_match,unique:string|undefined)=>'CREATE '+(unique??'')+'INDEX IF NOT EXISTS ');
   await db.unsafe(stmt);
  }
 }
 await db`GRANT SELECT ON public.ai_jobs TO authenticated`;
 await db`GRANT SELECT,INSERT ON public.ai_grade_flags TO authenticated`;
 await db`GRANT SELECT,INSERT,UPDATE,DELETE ON public.card_prereqs TO authenticated`;
 process.stdout.write('F33 isolated legacy bootstrap verified; F33 secret ACLs unchanged\n');
}finally{await db.end();}
