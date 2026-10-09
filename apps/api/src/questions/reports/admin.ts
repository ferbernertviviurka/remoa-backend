import { Hono } from 'hono';
import { err,parseWith,questionReportQueueQuerySchema,questionReportResolveInputSchema } from '@remoa/contracts';
import { withAdmin,reasonOf,send,type AdminEnv } from '../../admin/core';
import { idValid } from '../../admin/questions/service';
import { listReports,reportDetail,resolveReport,staff } from './service';
export const questionAdminReportRoutes=new Hono<AdminEnv>()
.get('/',async(c)=>send(await withAdmin(c,'question.report_view',{reason:'Consultar fila de problemas de questões',target:{type:'route',id:c.req.path}},async(tx,audit)=>{
 const actor=await staff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');
 const input=parseWith(questionReportQueueQuerySchema,c.req.query());if(!input.ok)return input;
 const result=await listReports(tx,actor,input.data);if(result.ok)audit.after({count:result.data.items.length});return result;
})))
.get('/:id',async(c)=>{
 const id=c.req.param('id');if(!idValid(id))return send(err('not_found','report not found'));
 return send(await withAdmin(c,'question.report_view',{reason:'Abrir relato de problema de questão',target:{type:'question_report',id}},async(tx,audit)=>{
  const actor=await staff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');const result=await reportDetail(tx,actor,id);if(result.ok)audit.after({id,questionId:result.data.report.questionId,status:result.data.report.status});return result;
 }));
})
.post('/:id/resolve',async(c)=>{
 const id=c.req.param('id');if(!idValid(id))return send(err('not_found','report not found'));const body=await c.req.json().catch(()=>null);
 return send(await withAdmin(c,'question.report_resolve',{reason:reasonOf(body),target:{type:'question_report',id}},async(tx,audit)=>{
  const actor=await staff(tx,c.get('admin').id,'admin');if(!actor)return err('not_found','route not found');const input=parseWith(questionReportResolveInputSchema,body);if(!input.ok)return input;return resolveReport(tx,actor,id,input.data,audit);
 }));
});
