/** SQL is inspected, not executed here. Live two-connection lock/rollback QA remains pending. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0050_f33_source_lock_order.sql',import.meta.url),'utf8');
describe('CCR130 source rights lock protocol',()=>{
 it('prelocks all papers then all questions by id before conditional distribution changes',()=>{
  const papers=migration.indexOf('PERFORM p.id'),questions=migration.indexOf('PERFORM q.id'),gate=migration.indexOf('IF NEW.rights_status');
  expect(papers).toBeGreaterThan(0);expect(questions).toBeGreaterThan(papers);expect(gate).toBeGreaterThan(questions);
  const locks=migration.slice(papers,gate);
  expect(locks.match(/ORDER BY [pq]\.id FOR UPDATE/g)).toHaveLength(2);
  expect(locks).not.toMatch(/status\s*=|catalog_status\s*=/);
 });
 it('preserves intrinsic availability and does not automatically publish on rights regrant',()=>{
  expect(migration).not.toMatch(/SET[^;]*availability/i);
  const assignments=[...migration.matchAll(/UPDATE public\.\w+ SET([\s\S]*?)\bWHERE\b/g)].map(match=>match[1]);
  expect(assignments).toHaveLength(2);
  for(const assignment of assignments)expect(assignment).not.toMatch(/(?:catalog_status|status)\s*=\s*'published'/i);
  expect(migration).toContain("catalog_status = 'withdrawn'");
  expect(migration).toContain("status = 'withdrawn'");
 });
 it('retains invoker rights, fixed search path and private function execution',()=>{
  expect(migration).toContain("SECURITY INVOKER SET search_path = ''");
  expect(migration).toContain('REVOKE ALL ON FUNCTION public.f33_source_rights_change() FROM PUBLIC, anon, authenticated');
  expect(migration).not.toMatch(/SECURITY DEFINER|GRANT/i);
 });
});
