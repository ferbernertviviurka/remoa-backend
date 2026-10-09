/** Source-only isolated SQL verification. No production/default URL execution. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {questionImportPageQuerySchema} from '@remoa/contracts';
import {importsPage} from './imports-page';
const url=process.env.TEST_DATABASE_URL,enabled=process.env.F33_HISTORY_SQL_TESTS==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)||!u.pathname.includes('f33_test')||process.env.DATABASE_URL!==url)throw Error('Requires explicitly isolated local f33_test TEST_DATABASE_URL');}
describe.skipIf(!enabled)('CCR139 imports page SQL — isolated execution pending',()=>{
 let db:typeof import('@remoa/db');const owner=randomUUID(),source=randomUUID(),doc=randomUUID(),ids=Array.from({length:60},()=>randomUUID());
 beforeAll(async()=>{process.env.SHARE_SECRET='synthetic-imports-page-sql-secret';db=await import('@remoa/db');await db.db.transaction(async tx=>{
  await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${owner}::uuid,${owner+'@example.invalid'})`);
  await tx.execute(sql`INSERT INTO question_sources(id,name,publisher,url,rights_status) VALUES(${source}::uuid,'Fonte sintética CCR139page','Testes','https://example.invalid/source','pending')`);
  await tx.execute(sql`INSERT INTO question_documents(id,actor_id,source_id,kind,object_key,sha256,bytes,pages) VALUES(${doc}::uuid,${owner}::uuid,${source}::uuid,'exam',${'questions/test/'+doc},${'a'.repeat(64)},100,1)`);
  for(const id of ids)await tx.execute(sql`INSERT INTO question_imports(id,actor_id,source_id,document_id,idempotency_key,parser_version,status,created_at) VALUES(${id}::uuid,${owner}::uuid,${source}::uuid,${doc}::uuid,${id},'synthetic','review','2026-10-09T00:00:00.123456Z'::timestamptz)`);
 });});
 afterAll(async()=>{if(db)await db.db.transaction(async tx=>{await tx.execute(sql`DELETE FROM question_imports WHERE source_id=${source}::uuid`);await tx.execute(sql`DELETE FROM question_documents WHERE id=${doc}::uuid`);await tx.execute(sql`DELETE FROM question_sources WHERE id=${source}::uuid`);await tx.execute(sql`DELETE FROM auth.users WHERE id=${owner}::uuid`);});});
 it('returnsall60 source-boundimports across three pages withaggregatezeros and no repeats',async()=>{await db.db.transaction(async tx=>{let cursor:string|undefined;const seen:string[]=[];for(let n=0;n<3;n++){const page=await importsPage(tx,{id:owner,role:'admin'},questionImportPageQuerySchema.parse({sourceId:source,cursor}),'imports/page');expect(page.ok).toBe(true);if(!page.ok)throw Error();seen.push(...page.data.items.map(r=>r.id));expect(page.data.items.every(r=>r.candidates===0)).toBe(true);cursor=page.data.nextCursor??undefined;}expect(new Set(seen)).toEqual(new Set(ids));expect(cursor).toBeUndefined();});});
});
