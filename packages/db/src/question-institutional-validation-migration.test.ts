/** D-1819: SQL is inspected, not executed here. Live trigger QA needs a disposable TEST_DATABASE_URL with0053 applied. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0053_f33_institutional_validation.sql',import.meta.url),'utf8');
const fn=(name:string)=>migration.slice(migration.indexOf(`FUNCTION public.${name}()`),migration.indexOf('END $$;',migration.indexOf(`FUNCTION public.${name}()`)));
describe('D-1819 institutional validation',()=>{
 it('adds the seal kind with a medical default, so existing rows and reviews stay medical',()=>{
  expect(migration).toMatch(/ADD COLUMN "validation_kind" text DEFAULT 'medical_review' NOT NULL/);
  expect(migration).toMatch(/ADD COLUMN "kind" text DEFAULT 'medical_review' NOT NULL/);
  expect(migration).toMatch(/question_sources_remoa_owned_uq" ON "question_sources" USING btree \("rights_scope"\) WHERE "question_sources"."rights_scope" = 'remoa_owned'/);
 });
 it('publish check keeps the full medical gate and gives the Remoa seal no CRM, a key and remoa_authored only',()=>{
  const chk=migration.slice(migration.indexOf('ADD CONSTRAINT "question_bank_publish_chk"'));
  expect(chk).toMatch(/"validation_kind" = 'medical_review' and "question_bank"."integrity_confirmed" and "question_bank"."key_final" and "question_bank"."enamed_confirmed" and nullif\(btrim\("question_bank"."reviewer_crm"\),''\) is not null/);
  expect(chk).toMatch(/"validation_kind" = 'remoa_institutional' and "question_bank"."user_id" is null and "question_bank"."origin" = 'remoa_authored' and "question_bank"."reviewer_crm" is null and "question_bank"."correct_key" is not null/);
 });
 it('review identity: medical needs a CRM (NULL-safe), institutional has none and only approves',()=>{
  expect(migration).toMatch(/when 'medical_review' then nullif\(btrim\("question_editorial_reviews"."reviewer_crm"\),''\) is not null else "question_editorial_reviews"."reviewer_crm" is null and "question_editorial_reviews"."decision" = 'approved' end/);
 });
 it('signature trigger: active admin, digit-free name, Remoa-owned authorized source, immutable kind',()=>{
  const sig=fn('f33_validate_signature');
  expect(sig).toMatch(/NEW\.kind='remoa_institutional'[\s\S]*role='admin' AND deleted_at IS NULL AND suspended_at IS NULL/);
  expect(sig).toMatch(/NEW\.reviewer_crm IS NOT NULL OR NEW\.decision<>'approved'[\s\S]*NEW\.reviewer_name ~ '\[0-9\]'/);
  expect(sig).toMatch(/q\.origin='remoa_authored'[\s\S]*s\.rights_scope='remoa_owned' AND s\.rights_status='authorized'/);
  expect(sig).toMatch(/NEW\.question_id,NEW\.kind,/);
  expect(sig).toMatch(/role='reviewer'/);
 });
 it('question trigger: seal kind is immutable once published and must match the latest review kind',()=>{
  const q=fn('f33_validate_question');
  expect(q).toMatch(/NEW\.reviewer_crm,NEW\.validation_kind,/);
  expect(q).toMatch(/r\.kind=NEW\.validation_kind AND r\.reviewer_crm IS NOT DISTINCT FROM NEW\.reviewer_crm/);
  expect(q).toMatch(/institutional_scope_required/);
  expect(q).toMatch(/invalid_public_question_taxonomy/);
  expect(q).toMatch(/source_rights_required/);
 });
});
