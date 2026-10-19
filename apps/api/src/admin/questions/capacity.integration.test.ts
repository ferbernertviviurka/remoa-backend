/** Frozen corpus coverage reconciles with the actual builder. Disposable local28k clone only; all changes roll back. */
import {randomUUID} from 'node:crypto';
import {afterAll,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import type {Tx} from '@remoa/db';
import {questionAcervoCoverageSchema,examBuilderFilterSchema} from '@remoa/contracts';
import {catalogCapacitySQL,type CatalogCapacity} from './capacity';
const fixture=vi.hoisted(()=>({tx:null as Tx|null}));
vi.mock('../../db',async original=>({...await original<typeof import('../../db')>(),run:async(_u:string,fn:(tx:Tx)=>Promise<unknown>)=>{if(!fixture.tx)throw Error('fixture_required');return fn(fixture.tx);}}));
const enabled=process.env.G29_ACERVO_SQL_TEST==='1'&&!!process.env.DATABASE_URL;
if(enabled){const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='127.0.0.1'||u.pathname!=='/remoa_g29_reliability_f33_test_20261019')throw Error('disposable_reliability_clone_required');}
describe.skipIf(!enabled)('G29 real public corpus coverage',()=>{
 let end:(()=>Promise<void>)|undefined;afterAll(async()=>{await end?.();});
 it('reconciles10courses and unclassified counts with availability, keeps source tags separate, excludes private/drafts and respects revocation',async()=>{
 const{db}=await import('@remoa/db'),{asServer}=await import('../../db'),{examBuilder}=await import('../../questions/builder/service');end=()=>db.$client.end({timeout:1});
 try{await db.transaction(async tx=>{fixture.tx=tx;await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
 const metrics=async()=>{const[row]=await asServer<CatalogCapacity>(tx,catalogCapacitySQL());return{...row!,acervo_coverage:questionAcervoCoverageSchema.parse(row!.acervo_coverage)};};
 const before=await metrics();expect(before.public_canonical).toBe(27483);const coverage=before.acervo_coverage;
 expect(coverage.eligibleTotal).toBe(27483);expect(coverage.unclassifiedArea).toBe(27483);expect(coverage.unclassifiedTopic).toBe(27483);expect(coverage.byCourse).toHaveLength(10);expect(coverage.byCourse.reduce((n,r)=>n+r.count,0)).toBe(27483);
 expect(coverage.sourceAreaTags).toHaveLength(14);expect(coverage.sourceAreaTags.reduce((n,r)=>n+r.count,0)).toBe(579);expect(coverage.sourceAreaTags.find(r=>r.code==='saude-publica')?.count).toBe(70);expect(coverage.sourceAreaTagsUnreviewed).toBe(true);expect(before.areas).toEqual([]);expect(before.topics).toEqual([]);
 const user=randomUUID();await tx.execute(sql`SET LOCAL ROLE NONE`);await tx.execute(sql`INSERT INTO auth.users(id,email) VALUES(${user},${user+'@example.invalid'})`);
 for(const row of coverage.byCourse){const availability=await examBuilder.availability(user,examBuilderFilterSchema.parse({source:'catalog',course:row.course}));expect(availability.total).toBe(row.count);}
 await tx.execute(sql`SET LOCAL ROLE NONE`);await tx.execute(sql`INSERT INTO question_bank(user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,origin) VALUES(${user},'objective','medium','Synthetic private exclusion','[{"key":"A","text":"One"},{"key":"B","text":"Two"}]'::jsonb,'A','Synthetic','student','user_authored')`);expect((await metrics()).acervo_coverage).toEqual(coverage);
 const [source]=await asServer<{id:string;n:number}>(tx,sql`SELECT source_id id,count(*)::int n FROM question_bank WHERE validation_kind='remoa_team_attested' AND availability='active' GROUP BY source_id ORDER BY count(*) DESC LIMIT 1`);
 const fingerprint=async()=>{const[r]=await asServer<{fp:string}>(tx,sql`SELECT md5(string_agg(to_jsonb(q)::text,'' ORDER BY q.id)) fp FROM question_bank q WHERE validation_kind='remoa_team_attested'`);return r!.fp;};const hash=await fingerprint();
 await tx.execute(sql`SET LOCAL ROLE NONE`);await tx.execute(sql`UPDATE question_sources SET rights_status='revoked' WHERE id=${source!.id}`);const revoked=await metrics();expect(revoked.acervo_coverage.eligibleTotal).toBe(27483-source!.n);expect(await fingerprint()).toBe(hash);
 throw Error('fixture_rollback');
 });}catch(e){if(!(e instanceof Error)||e.message!=='fixture_rollback')throw e;}finally{fixture.tx=null;}
 },120000);
});
