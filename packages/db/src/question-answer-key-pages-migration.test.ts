/** Source inspection only; this does not execute SQL or prove RLS/rollback. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration=readFileSync(new URL('../migrations/0051_f33_answer_key_pages.sql',import.meta.url),'utf8');
const journal=JSON.parse(readFileSync(new URL('../migrations/meta/_journal.json',import.meta.url),'utf8'));
const previous=JSON.parse(readFileSync(new URL('../migrations/meta/0050_snapshot.json',import.meta.url),'utf8'));
const snapshot=JSON.parse(readFileSync(new URL('../migrations/meta/0051_snapshot.json',import.meta.url),'utf8'));
describe('CCR133 answer key scope migration source',()=>{
 it('has the generated snapshot/journal chain without rewriting migration history',()=>{
  expect(snapshot.prevId).toBe(previous.id);
  expect(journal.entries.at(-1)).toMatchObject({idx:51,tag:'0051_f33_answer_key_pages',breakpoints:true});
  expect(journal.entries.at(-2)).toMatchObject({idx:50,tag:'0050_f33_source_lock_order'});
 });
 it('creates validation before its generated CHECK and keeps historical defaults nullable',()=>{
  expect(migration.indexOf('CREATE FUNCTION public.f33_valid_answer_key_pages')).toBeLessThan(migration.indexOf('ADD CONSTRAINT'));
  expect(snapshot.tables['public.question_imports'].columns.answer_key_pages).toMatchObject({type:'integer[]',notNull:false});
  expect(snapshot.tables['public.question_imports'].columns.answer_key_pages.default).toBeUndefined();
  expect(snapshot.tables['public.question_imports'].checkConstraints.question_imports_answer_key_pages_chk.value).toContain('f33_valid_answer_key_pages');
  expect(migration).not.toMatch(/UPDATE public\.question_imports|DELETE|TRUNCATE|DROP/i);
 });
 it('checks dimension/lowerbound/null/range/strict order and key-document association',()=>{
  for(const guard of ['array_ndims(pages) IS DISTINCT FROM 1','array_lower(pages, 1) IS DISTINCT FROM 1','cardinality(pages) NOT BETWEEN 1 AND 500','page_number IS NULL','page_number NOT BETWEEN 1 AND 500','page_number <= previous_page','answer_key_document_id" is not null'])expect(migration).toContain(guard);
  expect(migration).toContain("d.source_id = NEW.source_id AND d.kind = 'answer_key'");
  expect(migration).toContain('> document_pages');
 });
 it('locks selector and document binding but allows independent status/revision updates',()=>{
  const trigger=migration.slice(migration.indexOf('CREATE FUNCTION public.f33_answer_key_pages_guard'));
  expect(trigger).toContain('NEW.answer_key_pages IS DISTINCT FROM OLD.answer_key_pages');
  expect(trigger).toContain('NEW.answer_key_document_id IS DISTINCT FROM OLD.answer_key_document_id');
  expect(trigger).not.toMatch(/NEW\.(status|revision|cost_cents).*OLD/);
  expect(trigger).not.toMatch(/FOR (UPDATE|SHARE)|SECURITY DEFINER/);
 });
 it('preserves private table access and invoker function execution without new grants',()=>{
  expect(migration.match(/SECURITY INVOKER SET search_path = ''/g)).toHaveLength(2);
  expect(migration.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(2);
  expect(migration).toContain('ON public.question_imports FROM PUBLIC, anon, authenticated');
  expect(migration).not.toMatch(/\bGRANT\b|DISABLE ROW LEVEL SECURITY/i);
 });
});
