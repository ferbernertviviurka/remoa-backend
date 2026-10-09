import { randomUUID as uuid,createHmac } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { decodeReportCursor,encodeReportCursor } from './cursor';
const actor=uuid(),id=uuid(),at='2026-10-08T20:00:00.000001Z',filters={limit:30};
afterEach(()=>vi.unstubAllEnvs());
describe('report cursor authorization boundary',()=>{
 it('preserves microseconds and binds actor, role, limit and all filters',()=>{
  vi.stubEnv('SHARE_SECRET','synthetic-secret');const cursor=encodeReportCursor(at,id,actor,'reviewer',filters);expect(decodeReportCursor(cursor,actor,'reviewer',filters)).toEqual({at,id});
  for(const [owner,role,f]of[[uuid(),'reviewer',filters],[actor,'admin',filters],[actor,'reviewer',{limit:31}],[actor,'reviewer',{limit:30,status:'open'}],[actor,'reviewer',{limit:30,type:'key'}],[actor,'reviewer',{limit:30,questionId:uuid()}]] as const)expect(()=>decodeReportCursor(cursor,owner,role,f)).toThrow('invalid_report_cursor');
 });
 it('rejects truncated, oversized, unsigned, extra parts, bad JSON, invalid UUID and invalid microsecond date',()=>{
  vi.stubEnv('SHARE_SECRET','synthetic-secret');const valid=encodeReportCursor(at,id,actor,'reviewer',filters),data=Buffer.from('not-json').toString('base64url'),signed=data+'.'+createHmac('sha256','synthetic-secret').update('f33-report-cursor:'+data).digest('base64url');
  for(const value of ['',valid+'.x','onlydata','data.mac',valid.slice(0,-1),signed,'x'.repeat(1501),encodeReportCursor(at,'-'.repeat(36),actor,'reviewer',filters),encodeReportCursor('2026-99-99T20:00:00.000001Z',id,actor,'reviewer',filters),encodeReportCursor('2026-10-08T20:00:00Z',id,actor,'reviewer',filters)])expect(()=>decodeReportCursor(value,actor,'reviewer',filters)).toThrow('invalid_report_cursor');
 });
 it('requires a deployment secret before producing a next cursor',()=>{
  vi.stubEnv('SHARE_SECRET','');expect(()=>encodeReportCursor(at,id,actor,'reviewer',filters)).toThrow('missing SHARE_SECRET');
 });
});
