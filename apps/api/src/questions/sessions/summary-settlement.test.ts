import {beforeEach,describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const state=vi.hoisted(()=>({sql:vi.fn()}));
vi.mock('../../db',()=>({asServer:state.sql,pgArray:(ids:string[])=>ids,run:vi.fn()}));
vi.mock('../../cache',()=>({invalidate:vi.fn()}));
import {settleSessionSummaries} from './service';
const owner='44000000-0000-4000-8000-000000000001';const id=(n:number)=>'55000000-0000-4000-8000-'+String(n).padStart(12,'0');
const session=(n:number)=>({id:id(n),status:'active',revision:0,deadline:'2026-10-09T00:00:00Z',server_time:'2026-10-09T01:00:00Z'});
const reference={questionId:id(9),version:1,correctKey:'B',explanation:null,distractorNotes:null,annulled:false,reviewed:false,reviewerName:null,reviewerCrm:null,referenceDate:null,sourceUrl:null,obsolete:false};
beforeEach(()=>vi.clearAllMocks());
describe('CCR139 reused batch report freezing',()=>{
 it('freezes two expired sessions in one snapshot query and one update using existing report semantics',async()=>{
  const sessions=[session(1),session(2)];state.sql.mockResolvedValueOnce([{id:id(3),session_id:id(1),reference_snapshot:reference,selected_key:null,answered:true},{id:id(4),session_id:id(2),reference_snapshot:reference,selected_key:null,answered:false}]).mockResolvedValueOnce([{id:id(1),status:'expired',revision:1,finished_at:new Date()},{id:id(2),status:'expired',revision:1,finished_at:new Date()}]);
  await settleSessionSummaries({}as never,owner,sessions);expect(state.sql).toHaveBeenCalledTimes(2);expect(sessions.every(s=>s.status==='expired'&&s.revision===1)).toBe(true);
  const q=new PgDialect().sqlToQuery(state.sql.mock.calls[1]![1]);const reports=JSON.parse(q.params.find(p=>typeof p==='string'&&p.startsWith('[{"id"')) as string);expect(reports[0].report).toMatchObject({incorrect:1,unanswered:0,score:0});expect(reports[1].report).toMatchObject({incorrect:0,unanswered:1,score:0});expect(q.params).toContain(owner);
 });
 it('does not rewrite finished reports or sessions with no deadline',async()=>{await settleSessionSummaries({}as never,owner,[{...session(1),status:'finished'},{...session(2),deadline:null}]);expect(state.sql).not.toHaveBeenCalled();});
 it('deadline equal to authoritative time expires without waiting for later request',async()=>{const s=session(1);s.server_time=s.deadline;state.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{id:s.id,status:'expired',revision:1}]);await settleSessionSummaries({}as never,owner,[s]);expect(s.status).toBe('expired');});
});
