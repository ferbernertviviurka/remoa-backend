/** CCR-149 / D-1833: SQL is inspected, not executed. Live correctness + two-writer concurrency were checked on remoa_f33_bench (STATUS D-1833). */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0056_f34_question_superseded.sql',import.meta.url),'utf8');
const service=readFileSync(new URL('../../../apps/api/src/questions/catalog/service.ts',import.meta.url),'utf8');
const norm=(s:string)=>s.replace(/\s+/g,' ');
// The rule both sides must agree on: same group, strictly newer (version, created_at, id), visibility-dependent successor.
const rule=norm(`((q.visibility='private' AND newer.user_id=q.user_id) OR (q.visibility='public' AND newer.visibility='public' AND (newer.published_at IS NOT NULL OR newer.catalog_status='published')))`);
describe('0056 question_superseded',()=>{
 it('is server-only with RLS on and no policy',()=>{
  expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
  expect(migration).toContain('REVOKE ALL ON public.question_superseded FROM PUBLIC, anon, authenticated');
  expect(migration).not.toMatch(/CREATE POLICY|GRANT /i);
  expect(migration).toContain('ON DELETE cascade');
 });
 it('maintains the set from statement triggers on every write path of question_bank',()=>{
  for(const op of ['INSERT','UPDATE','DELETE'])expect(migration).toMatch(new RegExp(`AFTER ${op} ON public\\.question_bank REFERENCING[^;]*FOR EACH STATEMENT EXECUTE FUNCTION public\\.f34_question_superseded_on_write\\(\\)`));
  // Updates react to every input of the rule.
  for(const col of ['canonical_id','version','created_at','visibility','user_id','published_at','catalog_status'])expect(migration).toContain(`o.${col}`);
 });
 it('serializes each version group before reading it, in a stable order',()=>{
  const lock=migration.indexOf('pg_advisory_xact_lock'),read=migration.indexOf('WITH want');
  expect(lock).toBeGreaterThan(0);expect(read).toBeGreaterThan(lock);
  expect(migration).toMatch(/SELECT DISTINCT k FROM unnest\(keys\) k ORDER BY k/);
 });
 it('uses fixed search path, definer rights and private functions',()=>{
  expect(migration.match(/SECURITY DEFINER SET search_path = ''/g)).toHaveLength(2);
  expect(migration).toContain('REVOKE ALL ON FUNCTION public.f34_question_superseded_sync(uuid[]) FROM PUBLIC, anon, authenticated');
  expect(migration).toContain('REVOKE ALL ON FUNCTION public.f34_question_superseded_on_write() FROM PUBLIC, anon, authenticated');
 });
 it('never writes question_bank (no recursion, no f33_validate_question / updated_at side effects)',()=>{
  expect(migration).not.toMatch(/UPDATE public\.question_bank|INSERT INTO public\.question_bank|DELETE FROM public\.question_bank/);
 });
 it('trigger sync and backfill apply the same rule as the catalog latest predicate (or its replacement)',()=>{
  expect(norm(migration).split(rule).length-1).toBe(2);
  const api=norm(service);
  expect(api.includes(rule)||/question_superseded \w+ WHERE \w+\.question_id ?= ?q\.id/.test(api)).toBe(true);
 });
});
