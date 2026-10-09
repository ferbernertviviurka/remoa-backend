import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {idSchema,questionSessionsPageResultSchema,type QuestionSessionsPageQuery} from '@remoa/contracts';
import {asServer,run} from '../../db';
import {validation,type Row} from '../catalog/service';
import {settleSessionSummaries} from './service';
const secret=()=>{if(!process.env.SHARE_SECRET)throw Error('missing SHARE_SECRET for session history');return process.env.SHARE_SECRET;};
const binding=(userId:string,query:QuestionSessionsPageQuery,route:string)=>{const {cursor:_cursor,...filters}=query;void _cursor;return createHash('sha256').update(JSON.stringify({userId,route,order:'created_desc_uuid_desc',filters:Object.fromEntries(Object.entries(filters).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');};
export function historyCursor(at:string,id:string,userId:string,query:QuestionSessionsPageQuery,route:string){const data=Buffer.from(JSON.stringify({at,id,binding:binding(userId,query,route)})).toString('base64url');return data+'.'+createHmac('sha256',secret()).update('f33-session-history-v1:'+data).digest('base64url');}
export function readHistoryCursor(value:string,userId:string,query:QuestionSessionsPageQuery,route:string):{at:string;id:string}|null{
 const key=secret();try{const [data,mac,extra]=value.split('.');if(value.length>2048||!data||!mac||extra||!/^[-\w]+$/.test(data)||!/^[-\w]+$/.test(mac))return null;
 const bytes=Buffer.from(mac,'base64url'),expected=createHmac('sha256',key).update('f33-session-history-v1:'+data).digest();if(bytes.toString('base64url')!==mac||Buffer.from(data,'base64url').toString('base64url')!==data||bytes.length!==expected.length||!timingSafeEqual(bytes,expected))return null;
 const p=JSON.parse(Buffer.from(data,'base64url').toString());if(Object.keys(p).sort().join(',')!=='at,binding,id'||p.binding!==binding(userId,query,route)||typeof p.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(p.at)||Number.isNaN(Date.parse(p.at))||!idSchema.safeParse(p.id).success)return null;return {at:p.at,id:p.id};
 }catch{return null;}
}
export function sessionHistorySQL(userId:string,query:QuestionSessionsPageQuery,position:{at:string;id:string}|null){
 const where:SQL[]=[sql`s.user_id=${userId}::uuid`];if(query.mode)where.push(sql`s.mode=${query.mode}`);
 if(query.status)where.push(sql`CASE WHEN s.status='active' AND s.deadline IS NOT NULL AND s.deadline<=clock.at THEN 'expired' ELSE s.status END=${query.status}`);
 if(position)where.push(sql`(s.created_at,s.id)<(${position.at}::timestamptz,${position.id}::uuid)`);
 return sql`WITH clock AS MATERIALIZED(SELECT statement_timestamp() at), selected AS MATERIALIZED(SELECT s.id FROM question_sessions s CROSS JOIN clock WHERE ${sql.join(where,sql` AND `)} ORDER BY s.created_at DESC,s.id DESC LIMIT ${query.limit+1}),
 counts AS(SELECT i.session_id,count(*)::int count,count(*) FILTER(WHERE i.answered)::int answered_count FROM question_session_items i JOIN selected x ON x.id=i.session_id WHERE i.user_id=${userId}::uuid GROUP BY i.session_id)
 SELECT s.id,s.mode,s.status,s.revision,s.started_at,s.deadline,s.finished_at,clock.at server_time,coalesce(c.count,0) count,coalesce(c.answered_count,0) answered_count,
 to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
 FROM selected x JOIN question_sessions s ON s.id=x.id CROSS JOIN clock LEFT JOIN counts c ON c.session_id=s.id
 WHERE s.user_id=${userId}::uuid ORDER BY s.created_at DESC,s.id DESC FOR UPDATE OF s`;
}
/** Recheck time after waiting for locks. An active filter can legitimately settle during that wait. */
export async function sessionHistory(userId:string,query:QuestionSessionsPageQuery,route='/v1/question-sessions/history'){
 const position=query.cursor?readHistoryCursor(query.cursor,userId,query,route):null;if(query.cursor&&!position)throw validation('invalid_cursor');
 return run(userId,async tx=>{
  const rows=await asServer<Row>(tx,sessionHistorySQL(userId,query,position)),page=rows.slice(0,query.limit),last=page.at(-1);
  if(page.length){const [clock]=await asServer<Row>(tx,sql`SELECT clock_timestamp() server_time`);for(const row of page)row.server_time=clock!.server_time;await settleSessionSummaries(tx,userId,page);}
  return questionSessionsPageResultSchema.parse({items:page.map(s=>({id:s.id,mode:s.mode,status:s.status,revision:s.revision,startedAt:s.started_at,deadline:s.deadline??null,finishedAt:s.finished_at??null,serverTime:s.server_time,count:s.count,answeredCount:s.answered_count})),nextCursor:rows.length>query.limit&&last?historyCursor(String(last.cursor_at),String(last.id),userId,query,route):null});
 });
}
