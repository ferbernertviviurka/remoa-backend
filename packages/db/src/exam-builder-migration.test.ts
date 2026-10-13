/** F34 (CCR-147): SQL is inspected, not executed here. Live RLS A/B runs on a disposable TEST_DATABASE_URL with 0054 applied. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0054_f34_exam_builder.sql',import.meta.url),'utf8');
describe('0054 exam builder',()=>{
 it('templates are owner-only with RLS, select-only grant and owner cascade',()=>{
  expect(migration).toMatch(/ALTER TABLE public\.exam_templates ENABLE ROW LEVEL SECURITY/);
  expect(migration).toMatch(/REVOKE ALL ON public\.exam_templates FROM PUBLIC, anon, authenticated/);
  expect(migration).toMatch(/USING \(user_id = \(select auth\.uid\(\)\)\)/);
  expect(migration).toMatch(/GRANT SELECT ON public\.exam_templates TO authenticated;/);
  expect(migration).toMatch(/REFERENCES "auth"\."users"\("id"\) ON DELETE cascade/);
  expect(migration).not.toMatch(/CREATE TABLE "auth"/);
 });
 it('one active builder session per owner, only for builder configs',()=>{
  expect(migration).toMatch(/CREATE UNIQUE INDEX "question_sessions_one_active_builder_uq" ON "question_sessions" USING btree \("user_id"\) WHERE "question_sessions"\."status" = 'active' and "question_sessions"\."config" \? 'builder'/);
 });
});
