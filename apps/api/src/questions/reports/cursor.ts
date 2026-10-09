import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
import { idSchema } from '@remoa/contracts';
import { Abort } from '../../db';
export type ReportFilters={status?:string;type?:string;questionId?:string;limit:number;cursor?:string};
const hash=(actor:string,role:string,q:ReportFilters)=>createHash('sha256').update(JSON.stringify([actor,role,q.status??null,q.type??null,q.questionId??null,q.limit])).digest('hex');
const key=()=>{if(!process.env.SHARE_SECRET)throw Error('missing SHARE_SECRET for report cursor');return process.env.SHARE_SECRET;};
export function encodeReportCursor(at:string,id:string,actor:string,role:string,q:ReportFilters){
 const data=Buffer.from(JSON.stringify({at,id,scope:hash(actor,role,q)})).toString('base64url');return data+'.'+createHmac('sha256',key()).update('f33-report-cursor:'+data).digest('base64url');
}
export function decodeReportCursor(value:string,actor:string,role:string,q:ReportFilters):{at:string;id:string}{
 try{
  if(value.length>1500)throw Error();const [data,mac,extra]=value.split('.');if(!data||!mac||extra)throw Error();
  const expected=createHmac('sha256',key()).update('f33-report-cursor:'+data).digest(),actual=Buffer.from(mac,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
  const row=JSON.parse(Buffer.from(data,'base64url').toString());if(row.scope!==hash(actor,role,q)||!idSchema.safeParse(row.id).success||typeof row.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.at)||Number.isNaN(Date.parse(row.at)))throw Error();
  return {at:row.at,id:row.id};
 }catch{throw new Abort({code:'validation',message:'invalid_report_cursor'});}
}
