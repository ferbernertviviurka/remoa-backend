import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0060_g29_team_source_approval.sql',import.meta.url),'utf8');
const prior=readFileSync(new URL('../migrations/0050_f33_source_lock_order.sql',import.meta.url),'utf8');
describe('D-1885 source-only approval/revocation compatibility',()=>{
 it('changes legacy source revocation only by excluding immutable signed team rows',()=>{
  const fn=migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.f33_source_rights_change()'));
  const expected=prior.slice(prior.indexOf('CREATE OR REPLACE FUNCTION')).replace("WHERE source_id = NEW.id AND catalog_status = 'published';","WHERE source_id = NEW.id AND catalog_status = 'published'\n    AND validation_kind IS DISTINCT FROM 'remoa_team_attested';");
  expect(fn).toBe(expected);
 });
 it('keeps source approval narrow and identical for publication and visibility',()=>{
  expect(migration.match(/s\.rights_scope='g29-cp21-20261019' AND s\.rights_evidence='Aprovado por Remoa' AND s\.rights_expires_at IS NOT NULL/g)).toHaveLength(2);
  expect(migration.match(/s\.rights_expires_at>now\(\)/g)).toHaveLength(2);
  expect(migration).not.toMatch(/DISABLE TRIGGER|DROP TRIGGER|ALTER.*question_bank|UPDATE public\.question_team_items/i);
 });
});
