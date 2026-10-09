import { Hono,type Context } from 'hono';
import { err,ok,parseWith,questionReportQueueQuerySchema,questionReportResolveInputSchema,type Result } from '@remoa/contracts';
import type { Tx } from '@remoa/db';
import type { Env } from '../../app';
import { invalidate } from '../../cache';
import { Abort,dbm } from '../../db';
import { auditMeta,writeAudit,send,reasonOf,type AuditCapture } from '../../admin/core';
import { idValid } from '../../admin/questions/service';
import { listReports,reportDetail,resolveReport,staff,type ReportActor } from './service';
/** Reviewer triage is not a medical signature. Admin mutations use the reauthenticated admin endpoint. */
async function action<T extends object>(c:Context<Env>,id:string,reason:string,mutation:boolean,fn:(tx:Tx,actor:ReportActor,audit:AuditCapture)=>Promise<Result<T>>){
 const {db}=await dbm();let before:unknown=null,after:unknown=null;
 const base={...auditMeta(c),actorType:'user' as const,actorId:c.get('userId'),action:mutation?'question.report_resolve' as const:'question.report_view' as const,targetType:id==='queue'?'route' as const:'question_report' as const,targetId:id==='queue'?c.req.path:id};
 try{const result=await db.transaction(async(tx)=>{
  const actor=await staff(tx,c.get('userId'));if(!actor)return err('not_found','route not found');
  if(mutation&&actor.role==='admin')return err('forbidden','use_admin_report_route');
  const result=await fn(tx,actor,{before:v=>{before=v;},after:v=>{after=v;}});if(!result.ok)throw new Abort(result.error);
  const audit=await writeAudit({...base,reason,result:'success',before,after},tx);return ok({...result.data,...(mutation?{audit}:{})});
 });if(result.ok&&mutation)await invalidate('admin.action',{});return result;}catch(e){
  if(e instanceof Abort){await writeAudit({...base,reason:reason||null,result:'denied',denial:e.error.code==='conflict'?'invalid_state':'error'});return {ok:false as const,error:e.error};}throw e;
 }
}
export const questionEditorialReportRoutes=new Hono<Env>()
.get('/',async(c)=>send(await action(c,'queue','Consultar fila editorial de problemas de questões',false,async(tx,actor,audit)=>{
 const input=parseWith(questionReportQueueQuerySchema,c.req.query());if(!input.ok)return input;const result=await listReports(tx,actor,input.data);if(result.ok)audit.after({count:result.data.items.length});return result;
})))
.get('/:id',async(c)=>{
 const id=c.req.param('id');if(!idValid(id))return send(err('not_found','report not found'));
 return send(await action(c,id,'Abrir relato na fila editorial de questões',false,async(tx,actor,audit)=>{const result=await reportDetail(tx,actor,id);if(result.ok)audit.after({id,status:result.data.report.status});return result;}));
})
.post('/:id/resolve',async(c)=>{
 const id=c.req.param('id');if(!idValid(id))return send(err('not_found','report not found'));const body=await c.req.json().catch(()=>null);
 return send(await action(c,id,reasonOf(body),true,async(tx,actor,audit)=>{const input=parseWith(questionReportResolveInputSchema,body);if(!input.ok)return input;return resolveReport(tx,actor,id,input.data,audit);}));
});
