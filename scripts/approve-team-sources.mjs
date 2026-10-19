#!/usr/bin/env node
// Explicit human source approval only. Dry-run by default; credential never appears in arguments or output.
import {readFile,stat} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
const approval={rightsStatus:'authorized',rightsEvidence:'Aprovado por Remoa',rightsScope:'g29-cp21-20261019',rightsExpiresAt:'2030-11-19T23:59:59.000Z'};
const input={idempotencyKey:'749dd46a-9ce2-54c0-a311-91cd9de87894',reason:approval.rightsEvidence};
async function main(){
 const execute=process.argv.includes('--execute');console.log(JSON.stringify({mode:execute?'execute':'dry-run',expectedSources:841,approval}));if(!execute)return;
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
 const result=await request('/v1/admin/questions/team-publication/sources/approve',input);
 if(result.count!==841||JSON.stringify(result.approval)!==JSON.stringify(approval))throw Error('approval_readback_mismatch');
 console.log(JSON.stringify({approved:true,count:result.count,replayed:result.replayed,auditId:result.audit?.id??null,approval:result.approval}));
}
main().catch(error=>{const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'local_or_transport_error';console.error(`Source approval stopped (${code}); no credentials logged.`);process.exitCode=1;});
