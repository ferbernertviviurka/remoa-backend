/** G29-P: explicit isolated database only, synthetic fixtures always rolled back. */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { QUESTION_TEAM_ATTESTATION, QUESTION_TEAM_CORPUS_HASH, QUESTION_TEAM_MANIFEST_HASH, QUESTION_TEAM_MEMBERSHIP_HASH, QUESTION_TEAM_NAMESPACE } from '@remoa/contracts';
const target=process.env.TEST_DATABASE_URL;
const enabled=process.env.G29_TEAM_SQL_TESTS==='1' && !!target;
if(enabled && (!/^remoa_g29_test_/.test(new URL(target!).pathname.slice(1))||!['127.0.0.1','localhost'].includes(new URL(target!).hostname)))throw Error('G29 requires disposable local remoa_g29_test database');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
describe.skipIf(!enabled)('G29 team publication SQL security',()=>{
 it('pins manifest, rejects forged projection/scope/NULL, keeps signatures WORM, denies generic pending and revokes signed visibility',async()=>{
 const db=postgres(target!,{max:1,onnotice:()=>{}});
 try{await db.begin(async tx=>{
  const admin=randomUUID(),source=randomUUID(),question=randomUUID(),batch=randomUUID(),item=randomUUID();
  await tx`insert into auth.users(id,email)values(${admin},${admin+'@example.test'})`;
  await tx`update public.profiles set role='admin',name='Synthetic admin' where user_id=${admin}`;
  const denied=(fn:(q:postgres.TransactionSql)=>Promise<unknown>)=>tx.savepoint(fn).then(()=>false,()=>true);
  expect(await denied(sp=>sp`insert into public.question_team_batches(namespace,corpus_hash,manifest_hash,membership_hash,expected_count,attestation,actor_id) values('wrong',${QUESTION_TEAM_CORPUS_HASH},${QUESTION_TEAM_MANIFEST_HASH},${QUESTION_TEAM_MEMBERSHIP_HASH},28188,${QUESTION_TEAM_ATTESTATION},${admin})`)).toBe(true);
  await tx`insert into public.question_team_batches(id,namespace,corpus_hash,manifest_hash,membership_hash,expected_count,attestation,actor_id)values(${batch},${QUESTION_TEAM_NAMESPACE},${QUESTION_TEAM_CORPUS_HASH},${QUESTION_TEAM_MANIFEST_HASH},${QUESTION_TEAM_MEMBERSHIP_HASH},28188,${QUESTION_TEAM_ATTESTATION},${admin})`;
  await tx`insert into public.question_sources(id,name,publisher,url,rights_status)values(${source},'Official synthetic','Official synthetic','https://example.test','pending')`;
  const alternatives=[{key:'A',text:'Ação clínica'},{key:'B',text:'Texto\ncom aspas " e hífen −'}];
  const projected={stem:'Questão sintética, sem conteúdo médico.',alternatives,correctKey:'A',explanation:null,areaId:null,topicId:null,annulled:false,assets:[]};
  // Nested alternative keys use canonical alphabetic order (key,text).
  const contentHash=sha(JSON.stringify(projected));
  await tx`insert into public.question_bank(id,type,difficulty,stem,alternatives,correct_key,expected_answer,source,origin,visibility,catalog_status,rights_status,availability,source_id,content_hash,profession_code)values(${question},'objective','medium',${projected.stem},${tx.json(alternatives)},'A','','student','official_exam','public','in_review','pending','active',${source},${contentHash},'medicine')`;
  const payloadHash='a'.repeat(64),scope=sha(JSON.stringify({namespace:QUESTION_TEAM_NAMESPACE,itemId:item,offlineId:'synthetic',payloadHash,sourceId:source,origin:'official_exam',profession:'medicine',language:'pt-BR',contentHash,availability:'active',flags:[],rights:'pending',disclosure:1}));
  expect((await tx`select public.f33_team_content_hash(q) h from public.question_bank q where id=${question}`)[0]?.h).toBe(contentHash);
  const insert=(sp:postgres.TransactionSql,scopeHash:string)=>sp`insert into public.question_team_items(id,batch_id,offline_id,question_id,source_id,payload_hash,source_line_hash,content_hash,scope_hash,profession_code,original_payload)values(${item},${batch},'synthetic',${question},${source},${payloadHash},${'b'.repeat(64)},${contentHash},${scopeHash},'medicine','{}')`;
  expect(await denied(sp=>insert(sp,'c'.repeat(64)))).toBe(true);
  await insert(tx,scope);
  expect(await denied(sp=>sp`update public.question_team_items set scope_hash=${'d'.repeat(64)} where id=${item}`)).toBe(true);
  expect(await denied(sp=>sp`update public.question_team_batches set sealed_at=now() where id=${batch}`)).toBe(true);
  await tx`update public.profiles set role='student' where user_id=${admin}`;
  await expect(tx.savepoint(sp=>sp`update public.question_team_batches set sealed_at=now() where id=${batch}`)).rejects.toThrow('active_admin_team_batch_required');
  await tx`update public.profiles set role='admin' where user_id=${admin}`;
  expect(await denied(sp=>sp`update public.question_bank set catalog_status='published',status='approved',reviewed_hash=content_hash,reviewer_name='Remoa',validation_kind='remoa_team_attested',reference_date='2026-10-19' where id=${question}`)).toBe(true);
  await tx`insert into public.question_editorial_reviews(question_id,user_id,reviewer_name,kind,content_hash,decision,reason,reference_date,team_scope_hash)values(${question},${admin},'Remoa','remoa_team_attested',${contentHash},'approved',${QUESTION_TEAM_ATTESTATION},'2026-10-19',${scope})`;
  expect(await denied(sp=>sp`update public.question_bank set stem='Forged body' where id=${question}`)).toBe(false);
  expect(await denied(sp=>sp`update public.question_bank set catalog_status='published',status='approved',reviewed_hash=content_hash,reviewer_name='Remoa',validation_kind='remoa_team_attested',reference_date='2026-10-19' where id=${question}`)).toBe(true);
  await tx`update public.question_bank set stem=${projected.stem} where id=${question}`;
  expect(await denied(sp=>sp`update public.question_bank set catalog_status='published',status='approved',reviewed_hash=NULL,reviewer_name='Remoa',validation_kind='remoa_team_attested',reference_date='2026-10-19' where id=${question}`)).toBe(true);
  await tx`update public.question_bank set catalog_status='published',status='approved',reviewed_hash=content_hash,reviewer_name='Remoa',validation_kind='remoa_team_attested',reference_date='2026-10-19' where id=${question}`;
  expect(await denied(sp=>sp`update public.question_bank set availability='annulled' where id=${question}`)).toBe(true);
  expect(await denied(sp=>sp`update public.question_editorial_reviews set team_scope_hash=NULL where question_id=${question}`)).toBe(true);
  const visible=()=>tx.savepoint(async sp=>{await sp`set local role authenticated`;const n=(await sp`select id from public.question_bank where id=${question}`).length;await sp`reset role`;return n;});
  expect(await visible()).toBe(0);
  // Synthetic activation fixture only: full 28,188 membership seal is tested negative above.
  // Production cannot disable this trigger through the API/role; its positive full-manifest replay is an operational gate.
  await tx`alter table public.question_team_batches disable trigger f33_team_batch_guard`;
  await tx`update public.question_team_batches set sealed_at=now(),activated_at=now() where id=${batch}`;
  await tx`alter table public.question_team_batches enable trigger f33_team_batch_guard`;
  expect(await visible()).toBe(1);
  // The authenticated wrapper accepts only an ID; callers cannot enumerate candidate content hashes to discover a key.
  expect((await tx`select to_regprocedure('remoa_private.team_question_visible(uuid,text)') as oracle,has_function_privilege('authenticated','public.f33_team_question_visible(uuid,text)','EXECUTE') as hash_allowed`)[0]).toEqual({oracle:null,hash_allowed:false});
  expect(await denied(async sp=>{await sp`set local role authenticated`;await sp`select public.f33_team_question_visible(${question}::uuid,${contentHash}::text)`;})).toBe(true);
  expect(await denied(async sp=>{await sp`set local role authenticated`;await sp`select remoa_private.team_question_visible(${question}::uuid,${contentHash}::text)`;})).toBe(true);
  expect(await tx.savepoint(async sp=>{await sp`set local role authenticated`;const n=(await sp`select id from public.question_sources where id=${source}`).length;await sp`reset role`;return n;})).toBe(1);
  expect(await denied(async sp=>{await sp`set local role authenticated`;await sp`update public.question_team_batches set revoked_at=now() where id=${batch}`;})).toBe(true);
  expect(await denied(async sp=>{await sp`set local role authenticated`;await sp`select original_payload from public.question_team_items`;})).toBe(true);
  expect(await denied(async sp=>{await sp`set local role authenticated`;await sp`select correct_key from public.question_bank`;})).toBe(true);
  await tx`update public.question_sources set rights_status='revoked' where id=${source}`;
  expect(await visible()).toBe(0);
  await tx`update public.question_sources set rights_status='pending' where id=${source}`;
  await tx`update public.question_team_batches set revoked_at=now() where id=${batch}`;
  expect(await visible()).toBe(0);
  expect(await denied(sp=>sp`update public.question_team_batches set revoked_at=NULL where id=${batch}`)).toBe(true);
  throw Error('fixture_rollback');
 }).catch(e=>{if(!(e instanceof Error)||e.message!=='fixture_rollback')throw e;});}finally{await db.end();}
 },30000);
});
