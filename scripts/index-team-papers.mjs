#!/usr/bin/env node
// Index approved immutable G29 sources as partial excerpts only. Dry-run by default; credential never appears in arguments or output.
import {readFile,stat} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
const input={idempotencyKey:'e9d9a963-63b6-52ed-a5d9-7b75c836077d',reason:'Indexar o acervo aprovado por Remoa como recortes de fontes'};
async function main(){
 const execute=process.argv.includes('--execute');console.log(JSON.stringify({mode:execute?'execute':'dry-run',expectedPapers:841,expectedDocuments:822,expectedOccurrences:28188,coverageKind:'source_excerpt',expectedQuestionCount:null}));if(!execute)return;
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
 const result=await request('/v1/admin/questions/team-publication/papers/index',input);
 if(result.papers!==841||result.documents!==822||result.occurrences!==28188||result.coverageKind!=='source_excerpt')throw Error('paper_index_readback_mismatch');
 const check=await request('/v1/exams/catalog?limit=1');if(check.total!==841||check.items[0]?.coverage?.kind!=='source_excerpt')throw Error('paper_catalog_readback_mismatch');
 console.log(JSON.stringify({indexed:true,papers:result.papers,documents:result.documents,occurrences:result.occurrences,replayed:result.replayed,auditId:result.audit?.id??null,coverageKind:result.coverageKind}));
}
main().catch(error=>{const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'local_or_transport_error';console.error(`Paper indexing stopped (${code}); no credentials logged.`);process.exitCode=1;});
