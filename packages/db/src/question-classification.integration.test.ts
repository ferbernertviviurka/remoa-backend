/** Real fixed corpus, isolated clone only. Every fixture/index/withdrawal rolls back. */
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { QUESTION_CLASSIFICATION_BUNDLE_HASH } from '@remoa/contracts';
const target = process.env.TEST_DATABASE_URL;
const enabled = process.env.G29_CLASSIFICATION_SQL_TEST === '1' && !!target;
if (enabled && (!['127.0.0.1', 'localhost'].includes(new URL(target!).hostname) || new URL(target!).pathname !== '/remoa_g29_test_classification_arch_20261019')) throw Error('exclusive_classification_arch_clone_required');
describe.skipIf(!enabled)('G29 automatic classification SQL guards', () => {
  it('indexes pinned119/1209, preserves signed questions, rejects forged/private metadata and guards immutable unreviewed state', async () => {
    const raw = await readFile(new URL('../seed/question-classification/g29-v1.json', import.meta.url));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(QUESTION_CLASSIFICATION_BUNDLE_HASH);
    const bundle = JSON.parse(raw.toString()) as { runId:string;namespace:string;queueHash:string;ruleHash:string;ruleVersion:string;corpusHash:string;membershipHash:string;nodes:{id:string;runId:string;courseCode:string;kind:string;parentId:string|null;code:string;label:string}[];bindings:{runId:string;questionId:string;contentHash:string;payloadHash:string;courseCode:string;areaId:string;topicId:string;evidence:{ruleId:string;signals:{pattern:string;start:number;end:number;text:string}[]}}[] };
    const db = postgres(target!, { max: 1, onnotice: () => {} });
    try { await db.begin(async tx => {
      const actor = randomUUID();
      await tx`INSERT INTO auth.users(id,email) VALUES(${actor},${actor+'@example.invalid'})`;
      await tx`INSERT INTO profiles(user_id,role) VALUES(${actor},'admin') ON CONFLICT(user_id) DO UPDATE SET role='admin'`;
      const fingerprint = async () => (await tx`SELECT md5(string_agg(to_jsonb(q)::text,'' ORDER BY q.id)) fp FROM question_bank q WHERE validation_kind='remoa_team_attested'`)[0]!.fp;
      const before = await fingerprint();
      await tx`INSERT INTO question_classification_runs(id,namespace,queue_hash,rule_hash,rule_version,bundle_hash,corpus_hash,membership_hash,expected_count,expected_nodes,actor_id)
        VALUES(${bundle.runId},${bundle.namespace},${bundle.queueHash},${bundle.ruleHash},${bundle.ruleVersion},${QUESTION_CLASSIFICATION_BUNDLE_HASH},${bundle.corpusHash},${bundle.membershipHash},1209,119,${actor})`;
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_runs SET status='active',activated_at=now() WHERE id=${bundle.runId}`)).rejects.toThrow('classification_index_incomplete');
      const nodeRow = (n:typeof bundle.nodes[number]) => ({ id:n.id,run_id:n.runId,course_code:n.courseCode,kind:n.kind,parent_id:n.parentId,code:n.code,label:n.label });
      const firstArea = bundle.nodes.find(n => n.kind === 'area')!;
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_nodes ${sp({...nodeRow(firstArea),id:randomUUID(),course_code:'fabricated_course'})}`)).rejects.toThrow('question_classification_nodes_course_chk');
      const firstTopic = bundle.nodes.find(n => n.kind === 'topic')!;
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_nodes ${sp({...nodeRow(firstTopic),parent_id:randomUUID()})}`)).rejects.toThrow('classification_parent_mismatch');
      await tx`INSERT INTO question_classification_nodes ${tx(bundle.nodes.filter(n => n.kind === 'area').map(nodeRow))}`;
      await tx`INSERT INTO question_classification_nodes ${tx(bundle.nodes.filter(n => n.kind === 'topic').map(nodeRow))}`;
      const bindingRow = (b:typeof bundle.bindings[number]) => ({run_id:b.runId,question_id:b.questionId,content_hash:b.contentHash,payload_hash:b.payloadHash,course_code:b.courseCode,area_id:b.areaId,topic_id:b.topicId,evidence:b.evidence});
      const first = bundle.bindings[0]!;
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_bindings ${sp({...bindingRow(first),content_hash:'0'.repeat(64)})}`)).rejects.toThrow('classification_membership_hash_mismatch');
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_bindings ${sp({...bindingRow(first),payload_hash:'0'.repeat(64)})}`)).rejects.toThrow('classification_membership_hash_mismatch');
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_bindings ${sp({...bindingRow(first),question_id:randomUUID()})}`)).rejects.toThrow('classification_membership_hash_mismatch');
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_bindings ${sp({...bindingRow(first),evidence:{ruleId:first.courseCode+'.1',signals:[{pattern:'x',start:0,end:3,text:'XYZ'},{pattern:'y',start:0,end:3,text:'XYZ'}]}})}`)).rejects.toThrow('classification_evidence_mismatch');
      for (let i=0;i<bundle.bindings.length;i+=200) await tx`INSERT INTO question_classification_bindings ${tx(bundle.bindings.slice(i,i+200).map(bindingRow))}`;
      await tx`UPDATE question_classification_runs SET status='active',activated_at=now() WHERE id=${bundle.runId}`;
      expect((await tx`SELECT count(*)::int total,count(*)FILTER(WHERE q.availability='active')::int active FROM question_classification_bindings b JOIN question_bank q ON q.id=b.question_id`)[0]).toEqual({total:1209,active:1167});
      await tx`INSERT INTO question_classification_bindings ${tx(bindingRow(first))} ON CONFLICT DO NOTHING`;
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_bindings SET topic_id=${randomUUID()} WHERE question_id=${first.questionId}`)).rejects.toThrow('classification_binding_immutable');
      await expect(tx.savepoint(sp => sp`DELETE FROM question_classification_bindings WHERE question_id=${first.questionId}`)).rejects.toThrow('classification_binding_immutable');
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_nodes SET label='Human reviewed' WHERE id=${first.areaId}`)).rejects.toThrow('classification_node_immutable');
      await expect(tx.savepoint(sp => sp`INSERT INTO question_classification_nodes ${sp({...nodeRow(firstArea),id:randomUUID(),code:'new-append'})}`)).rejects.toThrow('classification_node_stage_required');
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_runs SET classification_kind='reviewed' WHERE id=${bundle.runId}`)).rejects.toThrow('classification_run_immutable');
      expect((await tx`SELECT has_table_privilege('authenticated','question_classification_bindings','SELECT') b,has_table_privilege('anon','question_classification_nodes','SELECT') n,has_table_privilege('authenticated','question_classification_runs','UPDATE') r`)[0]).toEqual({b:false,n:false,r:false});
      await tx`UPDATE question_classification_runs SET status='withdrawn',withdrawn_at=now() WHERE id=${bundle.runId}`;
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_runs SET status='active',withdrawn_at=NULL WHERE id=${bundle.runId}`)).rejects.toThrow('classification_phase_immutable');
      await expect(tx.savepoint(sp => sp`DELETE FROM question_classification_runs WHERE id=${bundle.runId}`)).rejects.toThrow('classification_run_immutable');
      await expect(tx.savepoint(sp => sp`UPDATE question_classification_runs SET actor_id=NULL WHERE id=${bundle.runId}`)).rejects.toThrow('classification_run_immutable');
      await tx`DELETE FROM auth.users WHERE id=${actor}`;
      expect((await tx`SELECT actor_id FROM question_classification_runs WHERE id=${bundle.runId}`)[0]!.actor_id).toBeNull();
      expect(await fingerprint()).toBe(before);
      throw Error('fixture_rollback');
    }).catch(error => { if (!(error instanceof Error) || error.message !== 'fixture_rollback') throw error; }); } finally { await db.end(); }
  }, 60000);
});
