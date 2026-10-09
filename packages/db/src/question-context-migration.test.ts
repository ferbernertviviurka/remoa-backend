/** Static checks only. Live role/trigger/rollback assertions remain an explicit integration gate. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0049_f33_import_contexts.sql',import.meta.url),'utf8');
describe('CCR130 source migration security',()=>{
 it('enables RLS, removes public roles and grants no direct authenticated policy',()=>{
 expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
 expect(migration).toContain('REVOKE ALL ON public.question_import_contexts FROM PUBLIC, anon, authenticated');
 expect(migration).not.toMatch(/CREATE POLICY/i);
 expect(migration).not.toMatch(/GRANT[^;]+TO authenticated/i);
 });
 it('guards source evidence and document linkage without security definer',()=>{
 for(const code of ['context_document_mismatch','context_evidence_immutable','context_revision_required'])expect(migration).toContain(code);
 expect(migration).not.toMatch(/SECURITY DEFINER/i);
 expect(migration).toContain('REVOKE ALL ON FUNCTION public.question_context_evidence_guard()');
 });
 it('includes uniqueness, lookup indexes, revision checks and durable decision checks',()=>{
 for(const name of ['question_contexts_import_evidence_uq','question_contexts_document_idx','question_contexts_import_status_idx','question_imports_revision_chk','question_contexts_revision_chk'])expect(migration).toContain(name);
 expect(migration).toContain("IS NOT DISTINCT FROM 'non_question'");
 });
});
