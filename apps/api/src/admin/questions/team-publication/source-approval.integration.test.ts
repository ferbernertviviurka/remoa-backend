/** Complete local frozen corpus only. Approval, audit and mutations all roll back. */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { approveBatchSources, SOURCE_APPROVAL } from './service';
import { teamReadable } from '../../../questions/catalog/service';
import { writeAudit } from '../../core/audit';
const url=process.env.DATABASE_URL,enabled=process.env.G29_CATALOG_SQL_TEST==='1'&&!!url;
if(enabled){const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/remoa_g29_full_test_20261019')throw Error('disposable_full_corpus_required');}
describe.skipIf(!enabled)('G29 complete source approval',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('approves only841 member sources, preserves every signed question, audits and durably replays with helper parity',async()=>{
  const {db}=await import('@remoa/db');end=()=>db.$client.end({timeout:1});
  try{await db.transaction(async tx=>{
   const [batch]=await tx.execute<{actor_id:string}>(sql`SELECT actor_id FROM question_team_batches WHERE namespace='g29-cp21-20261019'`);expect(batch?.actor_id).toBeTruthy();
   const fingerprint=async()=>{const [r]=await tx.execute<{fingerprint:string}>(sql`SELECT md5(string_agg(id::text||content_hash||coalesce(reviewed_hash,'')||rights_status||availability||coalesce(profession_code,''),'' ORDER BY id)) fingerprint FROM question_bank`);return r?.fingerprint;};
   const before=await fingerprint(),audit={before:vi.fn(),after:vi.fn()},input={idempotencyKey:randomUUID(),reason:'Aprovado por Remoa'};
   expect((await approveBatchSources(tx,batch!.actor_id,{...input,reason:'Wrong reason'},audit)).ok).toBe(false);
   const first=await approveBatchSources(tx,batch!.actor_id,input,audit);expect(first.ok&&first.data.count).toBe(841);expect(audit.before.mock.calls.at(-1)![0].sources).toHaveLength(841);
   await writeAudit({actorType:'admin',actorId:batch!.actor_id,action:'question.source_update',targetType:'route',targetId:'synthetic-source-approval',reason:input.reason,result:'success',before:audit.before.mock.calls.at(-1)![0],after:audit.after.mock.calls.at(-1)![0]},tx);
   const replay=await approveBatchSources(tx,batch!.actor_id,input,audit);expect(replay.ok&&replay.data.replayed).toBe(true);expect(await fingerprint()).toBe(before);
   const [count]=await tx.execute<{n:number}>(sql`SELECT count(*)::int n FROM question_sources WHERE rights_status='authorized' AND rights_scope=${SOURCE_APPROVAL.rightsScope} AND rights_evidence=${SOURCE_APPROVAL.rightsEvidence} AND rights_expires_at=${SOURCE_APPROVAL.rightsExpiresAt}::timestamptz`);expect(count?.n).toBe(841);
   const assertParity=async(expected:number)=>{const [r]=await tx.execute<{visible:number;mismatches:number}>(sql`SELECT count(*) FILTER(WHERE ${teamReadable})::int visible,count(*) FILTER(WHERE coalesce((${teamReadable}),false) IS DISTINCT FROM public.f33_team_question_visible(q.id,q.content_hash))::int mismatches FROM question_bank q`);expect(r?.mismatches).toBe(0);expect(r?.visible).toBe(expected);};
   await assertParity(28188);
   for(const [field,value]of [['rights_status','revoked'],['rights_scope','other'],['rights_evidence','other'],['rights_expires_at','2000-01-01T00:00:00Z'],['rights_expires_at',null]] as const){
    try{await tx.transaction(async sp=>{await sp.execute(sql`UPDATE question_sources SET ${sql.raw(field)}=${value} WHERE id IN(SELECT source_id FROM question_team_items)`);const [r]=await sp.execute<{n:number;mismatches:number}>(sql`SELECT count(*) FILTER(WHERE ${teamReadable})::int n,count(*) FILTER(WHERE coalesce((${teamReadable}),false) IS DISTINCT FROM public.f33_team_question_visible(q.id,q.content_hash))::int mismatches FROM question_bank q`);expect(r).toEqual({n:0,mismatches:0});throw Error('rollback_case');});}catch(e){if(!(e instanceof Error)||e.message!=='rollback_case')throw e;}
   }
   try{await tx.transaction(async sp=>{await sp.execute(sql`UPDATE question_team_batches SET revoked_at=now() WHERE namespace='g29-cp21-20261019'`);const [r]=await sp.execute<{n:number;mismatches:number}>(sql`SELECT count(*) FILTER(WHERE ${teamReadable})::int n,count(*) FILTER(WHERE coalesce((${teamReadable}),false) IS DISTINCT FROM public.f33_team_question_visible(q.id,q.content_hash))::int mismatches FROM question_bank q`);expect(r).toEqual({n:0,mismatches:0});throw Error('rollback_case');});}catch(e){if(!(e instanceof Error)||e.message!=='rollback_case')throw e;}
   throw Error('synthetic_fixture_rollback');
  });}catch(e){if(!(e instanceof Error)||e.message!=='synthetic_fixture_rollback')throw e;}
 },120000);
});
