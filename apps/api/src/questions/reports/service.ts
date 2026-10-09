import { sql,type SQL } from 'drizzle-orm';
import type { Tx } from '@remoa/db';
import { err,ok,questionReportQueueItemSchema,questionReportQueueSchema,questionReportDetailSchema,type QuestionReportQueueQuery,type QuestionReportResolveInput } from '@remoa/contracts';
import { decodeReportCursor,encodeReportCursor } from './cursor';
type Row=Record<string,unknown>;
export type ReportActor={id:string;role:'admin'|'reviewer'};
const columns=sql`r.id,r.question_id "questionId",r.version,r.type,r.description,r.status,r.created_at "createdAt",r.updated_at "updatedAt"`;
const dto=(r:Row)=>questionReportQueueItemSchema.parse(Object.fromEntries(['id','questionId','version','type','description','status','createdAt','updatedAt'].map(k=>[k,r[k]])));
const accessible=(a:ReportActor)=>a.role==='admin'?sql`true`:sql`(q.visibility='public' AND q.user_id IS NULL OR q.visibility='private' AND q.user_id=${a.id})`;
/** Lock active staff identity in the same transaction that reads or changes a report. */
export async function staff(tx:Tx,id:string,role?:ReportActor['role']){
 const [p]=await tx.execute<Row>(sql`SELECT role FROM profiles WHERE user_id=${id} AND deleted_at IS NULL AND suspended_at IS NULL FOR SHARE`);
 if(!p||(p.role!=='admin'&&p.role!=='reviewer')||(role&&p.role!==role))return null;
 return {id,role:p.role} as ReportActor;
}
export async function listReports(tx:Tx,actor:ReportActor,query:QuestionReportQueueQuery){
 const clauses:SQL[]=[accessible(actor)];
 if(query.status)clauses.push(sql`r.status=${query.status}`);if(query.type)clauses.push(sql`r.type=${query.type}`);if(query.questionId)clauses.push(sql`r.question_id=${query.questionId}`);
 if(query.cursor){const cursor=decodeReportCursor(query.cursor,actor.id,actor.role,query);clauses.push(sql`(r.created_at,r.id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)`);}
 const rows=await tx.execute<Row>(sql`SELECT ${columns},to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "cursorTime" FROM question_reports r JOIN question_bank q ON q.id=r.question_id WHERE ${sql.join(clauses,sql` AND `)} ORDER BY r.created_at DESC,r.id DESC LIMIT ${query.limit+1}`);
 const page=rows.slice(0,query.limit),last=page.at(-1);return ok(questionReportQueueSchema.parse({items:page.map(dto),nextCursor:rows.length>query.limit&&last?encodeReportCursor(String(last.cursorTime),String(last.id),actor.id,actor.role,query):null}));
}
export async function reportDetail(tx:Tx,actor:ReportActor,id:string){
 const [r]=await tx.execute<Row>(sql`SELECT ${columns},q.id "qId",q.version "qVersion",coalesce(q.canonical_id,q.id) "canonicalId",q.visibility,q.catalog_status "catalogStatus",q.availability,CASE WHEN q.visibility='public' OR q.user_id=${actor.id} THEN q.stem ELSE NULL END stem FROM question_reports r JOIN question_bank q ON q.id=r.question_id WHERE r.id=${id} AND ${accessible(actor)}`);
 if(!r)return err('not_found','report not found');
 const report=dto(r);
 return ok(questionReportDetailSchema.parse({report,question:{id:r.qId,version:r.qVersion,canonicalId:r.canonicalId,visibility:r.visibility,catalogStatus:r.catalogStatus,availability:r.availability,stem:r.stem},editable:true}));
}
export async function resolveReport(tx:Tx,actor:ReportActor,id:string,input:QuestionReportResolveInput,capture:{before(v:unknown):void;after(v:unknown):void}){
 const [r]=await tx.execute<Row>(sql`SELECT ${columns} FROM question_reports r JOIN question_bank q ON q.id=r.question_id WHERE r.id=${id} AND ${accessible(actor)} FOR UPDATE OF r`);
 if(!r)return err('not_found','report not found');
 capture.before({id,status:r.status,updatedAt:r.updatedAt});
 // A delivery retry after the successful update is a no-op, including with the old expected timestamp.
 if(r.status===input.status){capture.after({id,status:r.status,changed:false});return ok({report:dto(r),changed:false});}
 if(new Date(String(r.updatedAt)).getTime()!==input.expectedUpdatedAt.getTime())return err('conflict','report_changed');
 const [updated]=await tx.execute<Row>(sql`UPDATE question_reports r SET status=${input.status},updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=${id} RETURNING ${columns}`);
 if(!updated)return err('not_found','report not found');capture.after({id,status:input.status,changed:true});return ok({report:dto(updated),changed:true});
}
