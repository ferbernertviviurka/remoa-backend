/** Private transport evidence. No request, authentication header, URL or prompt is retained. */
export type HttpCompletionEnvelope={version:1;status:number;bodyBase64:string;bodyComplete:boolean;bodyBytes:number;errorCode:'body_limit'|'body_read_failed'|null;contentType:'application/json'|'text/plain'|null;model:string;attempts:number;fallback:boolean;latencyMs:number};
// Base64 plus JSON metadata fits within the existing 16 MiB private receipt limit.
export const HTTP_RECEIPT_MAX_BODY_BYTES=8*1024*1024;
export async function captureHttpEnvelope(res:Response,meta:Pick<HttpCompletionEnvelope,'model'|'attempts'|'fallback'|'latencyMs'>,bodyTimeoutMs=30_000):Promise<HttpCompletionEnvelope>{
 const reader=res.body?.getReader(),parts:Uint8Array[]=[];let size=0,complete=true,errorCode:HttpCompletionEnvelope['errorCode']=null;
 const deadline=AbortSignal.timeout(bodyTimeoutMs);let onAbort:(()=>void)|undefined;const timedOut=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(Error('body_deadline'));deadline.addEventListener('abort',onAbort,{once:true});});
 if(reader)try{for(;;){const {done,value}=await Promise.race([reader.read(),timedOut]);if(done)break;const room=HTTP_RECEIPT_MAX_BODY_BYTES-size;if(value.length>room){if(room>0)parts.push(value.subarray(0,room));size+=Math.max(0,room);complete=false;errorCode='body_limit';void reader.cancel().catch(()=>{});break;}parts.push(value);size+=value.length;}}catch{complete=false;errorCode='body_read_failed';void reader.cancel().catch(()=>{});}finally{if(onAbort)deadline.removeEventListener('abort',onAbort);reader.releaseLock();}
 else if(onAbort)deadline.removeEventListener('abort',onAbort);
 const type=res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
 return{version:1,status:res.status,bodyBase64:Buffer.concat(parts,size).toString('base64'),bodyComplete:complete,bodyBytes:size,errorCode,contentType:type==='application/json'||type==='text/plain'?type:null,...meta};
}
