/** F34 (CCR-148): SQL is inspected, not executed. 0055 is source only, never applied by the task. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const migration=readFileSync(new URL('../migrations/0055_f34_question_report_notification.sql',import.meta.url),'utf8');
describe('0055 question report notification',()=>{
 it('only adds the enum value',()=>{
  expect(migration.trim()).toBe(`ALTER TYPE "public"."notification_type" ADD VALUE 'question_report_resolved';`);
 });
});
