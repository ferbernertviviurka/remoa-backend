/** Source-only SQL gate. Disabled unless explicitly requested against an isolated local f33_test database. */
import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { questionAdminCatalogQuerySchema,questionHistoryQuerySchema } from '@remoa/contracts';
import { catalogPage,catalogStaff,versionHistory,reviewHistory } from './catalog';
const url=process.env.TEST_DATABASE_URL;
const enabled=process.env.F33_CATALOG_SQL_TESTS==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)||!u.pathname.includes('f33_test')||process.env.DATABASE_URL!==url)throw Error('Requires explicitly isolated local f33_test TEST_DATABASE_URL');}
describe.skipIf(!enabled)('CCR139 SQL integration — pending isolated database execution',()=>{
 const reviewer=randomUUID(),source=randomUUID(),old=randomUUID(),next=randomUUID(),privateId=randomUUID(),review=randomUUID();
 let db:typeof import('@remoa/db');
 beforeAll(async()=>{
  process.env.SHARE_SECRET='synthetic-catalog-integration-secret';db=await import('@remoa/db');
  await db.db.transaction(async tx=>{
   await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${reviewer}::uuid,${reviewer+'@example.invalid'})`);
   await tx.execute(sql`INSERT INTO profiles(user_id,role,name,crm) VALUES(${reviewer}::uuid,'reviewer','Revisor sintético','12345-SP') ON CONFLICT(user_id) DO UPDATE SET role='reviewer',name='Revisor sintético',crm='12345-SP'`);
   await tx.execute(sql`INSERT INTO question_sources(id,name,publisher,url,rights_status) VALUES(${source}::uuid,'Fonte sintética CCR139','Testes','https://example.invalid/source','pending')`);
   const alternatives=JSON.stringify([{key:'A',text:'Resposta sintética A'},{key:'B',text:'Resposta sintética B'}]);
   for(const [id,version] of [[old,1],[next,2]] as const)await tx.execute(sql`INSERT INTO question_bank(id,user_id,visibility,origin,source,source_id,type,difficulty,stem,alternatives,correct_key,status,catalog_status,canonical_id,supersedes_id,version,content_hash,created_at) VALUES(${id}::uuid,NULL,'public','official_exam','ai',${source}::uuid,'objective','easy','Questão sintética CCR139',${alternatives}::jsonb,'A','draft','in_review',${old}::uuid,${version===2?old:null}::uuid,${version},${'a'.repeat(64)},'2026-10-09T00:00:00.123456Z'::timestamptz)`);
   await tx.execute(sql`INSERT INTO question_bank(id,user_id,visibility,origin,source,type,difficulty,stem,alternatives,correct_key,status) VALUES(${privateId}::uuid,${reviewer}::uuid,'private','ai_generated','ai','objective','easy','Questão privada sintética',${alternatives}::jsonb,'A','draft')`);
   await tx.execute(sql`INSERT INTO question_editorial_reviews(id,question_id,reviewer_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) VALUES(${review}::uuid,${old}::uuid,${reviewer}::uuid,'Revisor sintético','SP-12345',${'a'.repeat(64)},'changes_requested','Solicitar conferência sintética','2026-10-09')`);
  });
 });
 afterAll(async()=>{if(!db)return;await db.db.transaction(async tx=>{await tx.execute(sql`DELETE FROM question_bank WHERE id IN (${next}::uuid,${old}::uuid,${privateId}::uuid)`);await tx.execute(sql`DELETE FROM question_sources WHERE id=${source}::uuid`);await tx.execute(sql`DELETE FROM auth.users WHERE id=${reviewer}::uuid`);});});
 it('paginates all versions at equal timestamp and hides private roots',async()=>{
  await db.db.transaction(async tx=>{const actor=await catalogStaff(tx,reviewer);expect(actor?.role).toBe('reviewer');if(!actor)return;
   const q=questionAdminCatalogQuerySchema.parse({sourceId:source,versions:'all',limit:1});const first=await catalogPage(tx,actor,q,'catalog');expect(first.ok).toBe(true);if(!first.ok)return;expect(first.data.items).toHaveLength(1);expect(first.data.nextCursor).toBeTruthy();const second=await catalogPage(tx,actor,{...q,cursor:first.data.nextCursor!},'catalog');expect(second.ok).toBe(true);if(second.ok)expect(second.data.items[0]!.id).not.toBe(first.data.items[0]!.id);
   const history=await versionHistory(tx,actor,old,questionHistoryQuerySchema.parse({}),'history');expect(history.ok).toBe(true);if(history.ok)expect(history.data.items).toHaveLength(2);
   expect((await versionHistory(tx,actor,privateId,questionHistoryQuerySchema.parse({}),'private')).ok).toBe(false);
  });
 });
 it('retains institutional review name/CRM/hash after signer deletion',async()=>{
  await db.db.transaction(async tx=>{await tx.execute(sql`DELETE FROM auth.users WHERE id=${reviewer}::uuid`);const result=await reviewHistory(tx,{id:randomUUID(),role:'admin'},old,questionHistoryQuerySchema.parse({}),'reviews');expect(result.ok).toBe(true);if(result.ok){expect(result.data.items[0]!.reviewerName).toBe('Revisor sintético');expect(result.data.items[0]!.contentHash).toBe('a'.repeat(64));}});
 });
});
