/** CCR144: SQL is inspected, not executed here. Live trigger QA needs a disposable TEST_DATABASE_URL with0052 applied. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0052_f33_outbox_recovery_budget.sql',import.meta.url),'utf8');
describe('CCR144 outbox recovery budget',()=>{
 it('defaults to the historical 20 and caps the lifetime budget at 25',()=>{
  expect(migration).toMatch(/ADD COLUMN "attempt_limit" integer DEFAULT 20 NOT NULL/);
  expect(migration).toMatch(/"attempt_limit" between 20 and 25/);
 });
 it('never lets history go down and never resets attempts',()=>{
  expect(migration).toMatch(/NEW\.attempts < OLD\.attempts OR NEW\.attempt_limit < OLD\.attempt_limit/);
  expect(migration).toMatch(/BEFORE UPDATE OF attempts, attempt_limit ON public\.question_outbox/);
  expect(migration).not.toMatch(/SET\s+attempts\s*=\s*0/i);
 });
});
