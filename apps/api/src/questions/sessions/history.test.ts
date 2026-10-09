import {beforeEach,describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import {questionSessionsPageQuerySchema} from '@remoa/contracts';
const state=vi.hoisted(()=>({sql:vi.fn(),settle:vi.fn()}));
vi.mock('../../db',()=>({asServer:state.sql,run:async(_user:string,fn:(tx:unknown)=>unknown)=>fn({})}));
vi.mock('./service',()=>({settleSessionSummaries:state.settle}));
import {historyCursor,readHistoryCursor,sessionHistorySQL,sessionHistory} from './history';
const owner='44000000-0000-4000-8000-000000000001',foreign='44000000-0000-4000-8000-000000000002';
const id=(n:number)=>'55000000-0000-4000-8000-'+String(n).padStart(12,'0');
const query=()=>questionSessionsPageQuerySchema.parse({});
const at='2026-10-09T12:00:00.123456Z';
const row=(n:number)=>({id:id(n),mode:'study',status:'active',revision:0,started_at:new Date(at),deadline:null,finished_at:null,server_time:new Date(at),cursor_at:at,count:5,answered_count:2,reference_snapshot:{correctKey:'A'},payload_public:{stem:'PRIVATE MUST NOT BE EMITTED'}});
beforeEach(()=>{vi.clearAllMocks();process.env.SHARE_SECRET='synthetic-history-secret';state.settle.mockResolvedValue(undefined);});
describe('CCR139 session history keyset and projection',()=>{
 it('preserves microseconds and rejects tamper, foreign owner, filter, route and limit changes',()=>{
  const q=query(),c=historyCursor(at,id(1),owner,q,'history');expect(readHistoryCursor(c,owner,q,'history')).toEqual({at,id:id(1)});
  for(const [u,f,r]of [[foreign,q,'history'],[owner,{...q,status:'active'},'history'],[owner,{...q,mode:'simulation'},'history'],[owner,{...q,limit:10},'history'],[owner,q,'elsewhere']] as const)expect(readHistoryCursor(c,u,f as typeof q,r)).toBeNull();expect(readHistoryCursor(c+'x',owner,q,'history')).toBeNull();
 });
 it('selects effective deadline status before limit and uses one clock with explicit owner and stable locks',()=>{
  const out=new PgDialect().sqlToQuery(sessionHistorySQL(owner,questionSessionsPageQuerySchema.parse({status:'active'}),null));expect(out.sql).toContain('statement_timestamp()');expect(out.sql).toContain('s.deadline<=clock.at');expect(out.sql).toContain('ORDER BY s.created_at DESC,s.id DESC LIMIT');expect(out.sql).toContain('FOR UPDATE OF s');expect(out.params.filter(p=>p===owner)).toHaveLength(3);expect(out.sql).not.toMatch(/reference_snapshot|payload_public|correct_key|shuffle_map/);
 });
 it('discovers all60 summaries across equal timestamps with no reference payload and no per-item queries',async()=>{
  const all=Array.from({length:60},(_,i)=>row(60-i));let cursor:string|undefined;const seen:string[]=[];
  for(let offset=0;offset<60;offset+=20){state.sql.mockResolvedValueOnce(all.slice(offset,offset+21)).mockResolvedValueOnce([{server_time:new Date(at)}]);const q=questionSessionsPageQuerySchema.parse({cursor});const page=await sessionHistory(owner,q);seen.push(...page.items.map(i=>i.id));expect(JSON.stringify(page)).not.toMatch(/PRIVATE|correctKey|reference_snapshot|payload_public/);cursor=page.nextCursor??undefined;}
  expect(seen).toEqual(all.map(r=>r.id));expect(new Set(seen).size).toBe(60);expect(cursor).toBeUndefined();expect(state.sql).toHaveBeenCalledTimes(6);expect(state.settle).toHaveBeenCalledTimes(3);
 });
 it('settles only returned20, not sentinel, and reflects deadline crossing during locks',async()=>{
  const rows=Array.from({length:21},(_,i)=>({...row(21-i),deadline:new Date(at)}));state.sql.mockResolvedValueOnce(rows).mockResolvedValueOnce([{server_time:new Date('2026-10-09T12:00:01Z')}]);state.settle.mockImplementation(async(_tx,_owner,selected)=>{expect(selected).toHaveLength(20);for(const r of selected){r.status='expired';r.revision++;r.finished_at=new Date('2026-10-09T12:00:01Z');}});const p=await sessionHistory(owner,questionSessionsPageQuerySchema.parse({status:'active'}));expect(p.items.every(r=>r.status==='expired'&&r.revision===1)).toBe(true);expect(rows[20]!.status).toBe('active');expect(p.nextCursor).not.toBeNull();
 });
 it('rejects invalid cursor before transactions or list access',async()=>{await expect(sessionHistory(owner,questionSessionsPageQuerySchema.parse({cursor:'tampered'}))).rejects.toThrow();expect(state.sql).not.toHaveBeenCalled();});
 it('empty page performs no clock or settlement queries',async()=>{state.sql.mockResolvedValueOnce([]);expect(await sessionHistory(owner,query())).toEqual({items:[],nextCursor:null});expect(state.sql).toHaveBeenCalledTimes(1);expect(state.settle).not.toHaveBeenCalled();});
});
