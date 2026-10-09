/** Written SQL gate only. Never enabled against a default/shared URL. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {questionSessionsPageQuerySchema} from '@remoa/contracts';
import {sessionHistorySQL,historyCursor,readHistoryCursor} from './history';
const url=process.env.TEST_DATABASE_URL,enabled=process.env.F33_HISTORY_SQL_TESTS==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)||!u.pathname.includes('f33_test')||process.env.DATABASE_URL!==url)throw Error('Requires explicitly isolated local f33_test TEST_DATABASE_URL');}
describe.skipIf(!enabled)('CCR139 history SQL — isolated execution pending',()=>{
 let db:typeof import('@remoa/db');const owner=randomUUID(),other=randomUUID(),ids=Array.from({length:60},()=>randomUUID());
 beforeAll(async()=>{process.env.SHARE_SECRET='synthetic-history-sql-secret';db=await import('@remoa/db');await db.db.transaction(async tx=>{
  for(const id of [owner,other])await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${id}::uuid,${id+'@example.invalid'})`);
  for(const [i,id]of ids.entries())await tx.execute(sql`INSERT INTO question_sessions(id,user_id,mode,config,idempotency_key,status,created_at,deadline) VALUES(${id}::uuid,${owner}::uuid,'study','{}'::jsonb,${id},${i<20?'active':'finished'},'2026-10-09T00:00:00.123456Z'::timestamptz,${i===0?'2026-01-01T00:00:00Z':null}::timestamptz)`);
  await tx.execute(sql`INSERT INTO question_sessions(user_id,mode,config,idempotency_key) VALUES(${other}::uuid,'simulation','{}'::jsonb,${randomUUID()})`);
 });});
 afterAll(async()=>{if(db)await db.db.transaction(async tx=>{await tx.execute(sql`DELETE FROM auth.users WHERE id IN(${owner}::uuid,${other}::uuid)`);});});
 it('discovers60 same-microsecond rows exactly once and excludes other owner',async()=>{await db.db.transaction(async tx=>{const seen:string[]=[];let cur:{at:string;id:string}|null=null;for(let n=0;n<3;n++){const q=questionSessionsPageQuerySchema.parse({});const rows=await tx.execute<Record<string,unknown>>(sessionHistorySQL(owner,q,cur));const page=rows.slice(0,20);seen.push(...page.map(r=>String(r.id)));if(rows.length>20){const last=page.at(-1)!;const c=historyCursor(String(last.cursor_at),String(last.id),owner,q,'history');cur=readHistoryCursor(c,owner,q,'history');}else cur=null;}expect(new Set(seen)).toEqual(new Set(ids));});});
 it('active deadline filtering leaves19 actualactive and exposes elapsed one through expired filter',async()=>{await db.db.transaction(async tx=>{const active=await tx.execute(sessionHistorySQL(owner,questionSessionsPageQuerySchema.parse({status:'active'}),null));expect(active).toHaveLength(19);const expired=await tx.execute<Record<string,unknown>>(sessionHistorySQL(owner,questionSessionsPageQuerySchema.parse({status:'expired'}),null));expect(expired.map(r=>r.id)).toEqual([ids[0]]);});});
});
