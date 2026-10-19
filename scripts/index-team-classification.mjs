#!/usr/bin/env node
// Index the server-pinned1209 automatic unreviewed suggestions only. Dry-run by default; credential never appears in arguments or output.
import {readFile,stat} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
const input={idempotencyKey:'341b59fd-b47a-5d69-8032-3da2cd3315ae',reason:'Disponibilizar classificações automáticas sugeridas, com aviso de não revisadas'};
async function main(){
 const execute=process.argv.includes('--execute');console.log(JSON.stringify({mode:execute?'execute':'dry-run',expectedBindings:1209,expectedNodes:119,classificationKind:'automatic_unreviewed',humanReviewed:false}));if(!execute)return;
 let token=process.env.REMOA_ADMIN_TOKEN;
 if(process.env.REMOA_ADMIN_TOKEN_FILE){const file=process.env.REMOA_ADMIN_TOKEN_FILE,s=await stat(file);if(!s.isFile()||(s.mode&0o777)!==0o600)throw Error('token_file_requires_0600');token=(await readFile(file,'utf8')).trim();}
 if(!token||/\s/.test(token))throw Error('legitimate_admin_token_required');
 const base='https://backend.remoa.com.br';
 async function request(path,body){for(let attempt=0;attempt<5;attempt++){
  let r;try{r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(120000)});}catch{if(attempt===4)throw Error('transport_retry_exhausted');await sleep(2000*2**attempt);continue;}
  if(r.status===429||r.status>=500){if(attempt===4)throw Error(`http_retry_exhausted_${r.status}`);await sleep(r.status===429?61000:2000*2**attempt);continue;}
  if(!r.ok)throw Error(`operation_failed_http_${r.status}`);const b=await r.json();if(b.ok!==true)throw Error('operation_rejected');return b.data;
 }}
 await request('/v1/admin/me');
 const result=await request('/v1/admin/questions/team-publication/classification/index',input);
 if(result.bindings!==1209||result.nodes!==119||result.classificationKind!=='automatic_unreviewed'||result.humanReviewed!==false)throw Error('classification_index_readback_mismatch');
 const check=await request('/v1/questions/classification?course=medicine');if(!check.areas.some(a=>a.classificationKind==='automatic_unreviewed'))throw Error('classification_catalog_readback_mismatch');
 console.log(JSON.stringify({indexed:true,bindings:result.bindings,nodes:result.nodes,runId:result.runId,replayed:result.replayed,auditId:result.audit?.id??null,classificationKind:result.classificationKind,humanReviewed:false}));
}
main().catch(error=>{const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'local_or_transport_error';console.error(`Automatic classification indexing stopped (${code}); no credentials logged.`);process.exitCode=1;});
