/** Explicit isolated local DB only; storage mocked; no production credentials or network. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { questionSourceSchema } from '@remoa/contracts';
import { assertF33TestDb } from '../../../questions/test-db-guard';
import { createBatch, importItems, activateBatch, verifyActivationAssets } from './service';
import { writeAudit } from '../../core/audit';
import { snapshotReference } from '../../../questions/sessions/service';
import { fixedId, pins, project, parseBatch } from './domain';
vi.mock('../../../storage/storage',()=>({headObject:vi.fn(),getBytes:vi.fn(),putBytes:vi.fn()}));
const url=process.env.DATABASE_URL;
if(url){const u=new URL(url);if(process.env.G29_TEAM_FULL_REPLAY==='1'&&(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/remoa_g29_full_test_20261019'))throw Error('full_replay_requires_disposable_full_db');if(!(['127.0.0.1','localhost'].includes(u.hostname)&&['/remoa_g29_test_20261019','/remoa_g29_full_test_20261019'].includes(u.pathname)))assertF33TestDb(url);}
const packagePath=process.env.G29_TEAM_TEST_PACKAGE;
describe.skipIf(!url||!packagePath)('frozen team batch on isolated DB',()=>{
 it('ingests a pinned 200-item lot, reconciles replay, preserves originals, cannot activate partial corpus',async()=>{
  const {db,questionSourcesCatalog}=await import('@remoa/db');const {headObject,getBytes}=await import('../../../storage/storage');
  const raw=readFileSync(`${packagePath}/${pins.batches[0]!.arquivo}`,'utf8'),rows=parseBatch(1,raw),projected=rows.map(project);
  const originals=process.env.G29_TEAM_TEST_ORIGINALS;if(!originals)throw Error('explicit_originals_required');
  const byKey=new Map(pins.files.map(p=>[`questions/team-publication/g29-cp21-20261019/sha256/${p.sha256}`,p]));
  vi.mocked(headObject).mockImplementation(async key=>{const p=byKey.get(key);return p?{size:p.bytes,mime:'application/pdf'}:null;});
  vi.mocked(getBytes).mockImplementation(async key=>readFileSync(`${originals}/${byKey.get(key)!.path}`));
  const actor=randomUUID(),audit={before:vi.fn(),after:vi.fn()};
  try{await db.transaction(async tx=>{
   await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${actor},${actor+'@example.invalid'})`);
   await tx.execute(sql`UPDATE profiles SET role='admin' WHERE user_id=${actor}`);
   expect((await createBatch(tx,actor,audit)).ok).toBe(true);
   const idempotencyKey=randomUUID();
   expect((await importItems(tx,actor,{batchIndex:1,rawJsonl:raw,idempotencyKey,reason:'Synthetic frozen import'},audit)).ok).toBe(true);
   await writeAudit({actorType:'admin',actorId:actor,action:'question.team_items_import',targetType:'route',targetId:'synthetic',reason:'Synthetic frozen import',result:'success',after:audit.after.mock.calls.at(-1)![0]},tx);
   const durable=await importItems(tx,actor,{batchIndex:1,rawJsonl:raw,idempotencyKey,reason:'Synthetic durable replay'},audit);expect(durable.ok&&durable.data.replayed).toBe(true);
   const changed=await importItems(tx,actor,{batchIndex:2,rawJsonl:readFileSync(`${packagePath}/${pins.batches[1]!.arquivo}`,'utf8'),idempotencyKey,reason:'Synthetic changed replay'},audit);expect(changed.ok).toBe(false);
   const result=await importItems(tx,actor,{batchIndex:1,rawJsonl:raw,idempotencyKey:randomUUID(),reason:'Synthetic replay import'},audit);expect(result.ok&&result.data.replayed).toBe(true);
   const [count]=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM question_team_items WHERE batch_id=${fixedId('batch')}`);expect(count?.n).toBe(200);
   const [item]=await tx.execute<{original_payload:unknown;rights_status:string;visible:boolean}>(sql`SELECT i.original_payload,q.rights_status,public.f33_team_question_visible(q.id,q.content_hash) visible FROM question_team_items i JOIN question_bank q ON q.id=i.question_id WHERE q.id=${projected[0]!.questionId}`);expect(item?.original_payload).toEqual(rows[0]!.payload);expect(item?.rights_status).toBe('pending');expect(item?.visible).toBe(false);
   const incomplete=await activateBatch(tx,actor,audit);expect(incomplete.ok).toBe(false);
   throw Error('synthetic_fixture_rollback');
  });}catch(e){if(!(e instanceof Error)||e.message!=='synthetic_fixture_rollback')throw e;}
  try{
   if(process.env.G29_TEAM_FULL_REPLAY==='1'){
    await db.transaction(async tx=>{
     await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${actor},${actor+'@example.invalid'})`);
     await tx.execute(sql`UPDATE profiles SET role='admin' WHERE user_id=${actor}`);
     expect((await createBatch(tx,actor,audit)).ok).toBe(true);
    });
    for(let index=1;index<=pins.batches.length;index++)await db.transaction(async tx=>{
     const imported=await importItems(tx,actor,{batchIndex:index,rawJsonl:readFileSync(`${packagePath}/${pins.batches[index-1]!.arquivo}`,'utf8'),idempotencyKey:randomUUID(),reason:'Synthetic full frozen replay'},audit);expect(imported.ok).toBe(true);
     await writeAudit({actorType:'admin',actorId:actor,action:'question.team_items_import',targetType:'route',targetId:'synthetic-full',reason:'Synthetic full frozen import',result:'success',after:audit.after.mock.calls.at(-1)![0]},tx);
    });
    const [mirror]=await db.execute<Record<string,unknown>>(sql`SELECT q.*,s.url source_url,true reviewed FROM question_bank q JOIN question_sources s ON s.id=q.source_id JOIN question_team_items i ON i.question_id=q.id WHERE s.name LIKE '%espelho de pesquisa' AND q.availability='active' LIMIT 1`);
    expect(mirror).toBeTruthy();expect(snapshotReference(mirror!).sourceUrl).toMatch(/^https:\/\/github.com\//);
    for(const source of await db.select().from(questionSourcesCatalog))expect(questionSourceSchema.safeParse(source).success).toBe(true);
    const proof=await verifyActivationAssets();
    await db.transaction(async tx=>{expect((await activateBatch(tx,actor,audit,proof)).ok).toBe(true);});
    const counts=await db.execute<{profession_code:string;n:number}>(sql`SELECT q.profession_code,count(*)::int n FROM question_bank q JOIN question_team_items i ON i.question_id=q.id WHERE public.f33_team_question_visible(q.id,q.content_hash) GROUP BY q.profession_code`);
    expect(counts).toHaveLength(10);expect(counts.reduce((n,r)=>n+r.n,0)).toBe(28188);
   }
  }finally{await db.$client.end({timeout:1});}
 },600000);
});
