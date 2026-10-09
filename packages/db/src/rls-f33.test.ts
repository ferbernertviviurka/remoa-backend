/** F33 integration: only explicitly named isolated test databases. Synthetic fixtures, rolled back. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
const url = process.env.DATABASE_URL;
if (url && !new URL(url).pathname.includes('f33_test')) throw new Error('F33 test requires explicitly isolated f33_test database');
const db = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
describe.skipIf(!db)('F33 schema invariants and RLS', () => {
  afterAll(async () => { await db?.end(); });
  it('private owners, variable keys, no direct references, publication rights/reviewer gate, immutable content and revoke', async () => {
    const result = await db!.begin(async (tx) => {
      const [owner, other, reviewer] = [randomUUID(), randomUUID(), randomUUID()];
      for (const uid of [owner, other, reviewer]) await tx`insert into auth.users(id,email) values (${uid},${uid + '@f33.example'})`;
      await tx`update profiles set role = 'reviewer', name = 'Synthetic reviewer', crm = '12345-SP' where user_id = ${reviewer}`;
      const [source] = await tx`insert into question_sources(name,publisher,url,rights_status,rights_evidence) values ('synthetic','synthetic','https://example.org','authorized','synthetic test evidence') returning id`;
      const [area] = await tx`insert into enamed_taxonomy(code,kind,area,name) values (${owner},'area','CM','synthetic') returning id`;
      const [topic] = await tx`insert into enamed_taxonomy(code,kind,area,name,parent_id) values (${other},'topic','CM','synthetic',${area!.id}) returning id`;
      const alternatives = ['A','B','C','D','E'].map((key) => ({ key, text: 'Synthetic ' + key }));
      const [question] = await tx`insert into question_bank(user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source)
        values (${owner},'objective','medium','synthetic',${tx.json(alternatives)}::jsonb,'E','Synthetic E','student') returning id`;
      type Tx = postgres.TransactionSql;
      const denied = (fn: (sp: Tx) => Promise<unknown>) => tx.savepoint(fn).then(() => false, () => true);
      const asUser = <T>(uid: string, fn: (sp: Tx) => Promise<T>) => tx.savepoint(async (sp) => {
        await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
        await sp`set local role authenticated`;
        const value = await fn(sp); await sp`reset role`; return value;
      });
      const asAnon = (fn: (sp: Tx) => Promise<unknown>) => tx.savepoint(async (sp) => { await sp`set local role anon`; return fn(sp); }).then(() => false, () => true);
      const out: Record<string, unknown> = {
        own: (await asUser(owner, (sp) => sp`select id from question_bank where id = ${question!.id}`)).length,
        other: (await asUser(other, (sp) => sp`select id from question_bank where id = ${question!.id}`)).length,
        referenceDenied: await denied((sp) => asUser(owner, () => sp`select correct_key from question_bank`)),
        anonDenied: await asAnon((sp) => sp`select id from question_bank`),
        keyNotMember: await denied((sp) => sp`update question_bank set correct_key = 'J' where id = ${question!.id}`),
        duplicateKey: await denied((sp) => sp`update question_bank set alternatives = '[{"key":"A","text":"one"},{"key":"A","text":"two"}]' where id = ${question!.id}`),
        prematurePublish: await denied((sp) => sp`update question_bank set catalog_status = 'published' where id = ${question!.id}`),
      };
      const hash = 'a'.repeat(64);
      await tx`update question_bank set visibility='public', origin='official_exam', user_id=null, source_id=${source!.id}, status='approved', explanation='Synthetic comment, no medical content', rights_status='authorized', integrity_confirmed=true, key_final=true, enamed_confirmed=true, enamed_area_id=${area!.id}, enamed_topic_id=${topic!.id}, content_hash=${hash}, reviewed_hash=${hash}, reviewer_name='Synthetic reviewer', reviewer_crm='12345-SP', reference_date='2026-10-08' where id=${question!.id}`;
      out.missingReview = await denied((sp) => sp`update question_bank set catalog_status='published' where id=${question!.id}`);
      await tx`insert into question_editorial_reviews(question_id,user_id,reviewer_name,reviewer_crm,content_hash,decision,reason,reference_date) values (${question!.id},${reviewer},'Synthetic reviewer','12345-SP',${hash},'approved','Synthetic test only','2026-10-08')`;
      await tx`update question_bank set catalog_status='published' where id=${question!.id}`;
      out.publishedVisible = (await asUser(other, (sp) => sp`select id from question_bank where id=${question!.id}`)).length;
      out.contentImmutable = await denied((sp) => sp`update question_bank set stem='changed' where id=${question!.id}`);
      await tx`update question_sources set rights_status='revoked' where id=${source!.id}`;
      out.revokedHidden = (await asUser(other, (sp) => sp`select id from question_bank where id=${question!.id}`)).length;
      throw Object.assign(new Error('rollback'), { result: out });
    }).catch((e: { result?: Record<string, unknown> }) => { if (e.result) return e.result; throw e; });
    expect(result).toEqual({ own: 1, other: 0, referenceDenied: true, anonDenied: true, keyNotMember: true, duplicateKey: true, prematurePublish: true, missingReview: true, publishedVisible: 1, contentImmutable: true, revokedHidden: 0 });
  });
  it('session correctness/reference grants remain hidden before and after finish; attempts append only', async () => {
    const result = await db!.begin(async (tx) => {
      const owner = randomUUID(); await tx`insert into auth.users(id,email) values (${owner},${owner + '@f33.example'})`;
      const [q] = await tx`insert into question_bank(user_id,type,difficulty,stem,alternatives,correct_key,expected_answer,source) values (${owner},'objective','easy','synthetic','[{"key":"A","text":"one"},{"key":"B","text":"two"}]','A','one','student') returning id`;
      const [s] = await tx`insert into question_sessions(user_id,mode,config,idempotency_key) values (${owner},'simulation','{}',${owner}) returning id`;
      const [i] = await tx`insert into question_session_items(user_id,session_id,question_id,position,payload_public,reference_snapshot) values (${owner},${s!.id},${q!.id},0,'{}','{"correctKey":"A"}') returning id`;
      const [a] = await tx`insert into question_answers(user_id,session_id,item_id,mutation_id,selected_key,correct,elapsed_ms,revision) values (${owner},${s!.id},${i!.id},${randomUUID()},'A',true,100,0) returning id`;
      const denied = (fn: (sp: postgres.TransactionSql) => Promise<unknown>) => tx.savepoint(fn).then(() => false, () => true);
      const studentDenied = (field: string, table: string) => denied(async (sp) => {
        await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: 'authenticated' })}, true)`; await sp`set local role authenticated`; await sp.unsafe(`select ${field} from ${table}`);
      });
      const out = { reference: await studentDenied('reference_snapshot','question_session_items'), report: await studentDenied('report','question_sessions'), correctness: await studentDenied('correct','question_answers'), update: await denied((sp) => sp`update question_answers set correct=false where id=${a!.id}`), delete: await denied((sp) => sp`delete from question_answers where id=${a!.id}`) };
      throw Object.assign(new Error('rollback'), { result: out });
    }).catch((e: { result?: Record<string, boolean> }) => { if (e.result) return e.result; throw e; });
    expect(result).toEqual({ reference: true, report: true, correctness: true, update: true, delete: true });
  });
});
