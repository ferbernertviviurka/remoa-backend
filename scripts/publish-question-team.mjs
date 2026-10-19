#!/usr/bin/env node
// Headless transport only. It never logs credentials, creates sessions, or writes a database directly.
import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const sha = value => createHash('sha256').update(value).digest('hex');
const namespace = 'g29-cp21-20261019';
const manifestHash = 'f3d40e71a86c071b2792e49bb09e1f3030b9aaf3ca66e94a94cba1055a0afc63';
const reason = 'Publicar acervo: todas foram validadas pelo time da Remoa, conforme declaração de Fernando em 19/10/2026.';
const args = process.argv.slice(2), execute = args.includes('--execute');
function option(name) { const i=args.indexOf(name); return i<0?undefined:args[i+1]; }
function key(label) { const h=sha(`${namespace}:${label}`); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; }
function safePath(base,path) { const full=resolve(base,path);if(relative(base,full).startsWith('..')||full===base)throw Error('unsafe_local_path');return full; }
async function main() {
 const pkg=resolve(option('--package')??''), originals=resolve(option('--originals')??'');
 if(!option('--package')||!option('--originals'))throw Error('usage: --package PATH --originals PATH [--api HTTPS_URL --checkpoint PATH --execute]; token only REMOA_ADMIN_TOKEN or REMOA_ADMIN_TOKEN_FILE (0600)');
 const pins=JSON.parse(await readFile(new URL('../apps/api/src/admin/questions/team-publication/pins.json',import.meta.url),'utf8'));
 if(sha(await readFile(resolve(pkg,'MANIFESTO.json')))!==manifestHash)throw Error('manifest_changed');
 const batches=[];
 for(const p of pins.batches){const raw=await readFile(safePath(pkg,p.arquivo));if(raw.length!==p.bytes||sha(raw)!==p.sha256)throw Error('batch_changed');batches.push(raw.toString('utf8'));}
 for(const p of pins.files){const raw=await readFile(safePath(originals,p.path));if(raw.length!==p.bytes||sha(raw)!==p.sha256)throw Error('asset_changed');}
 const chunks=[];let chunk=[],size=0;
 for(const p of pins.files){if(chunk.length===20||size+p.bytes>50*1024*1024){chunks.push(chunk);chunk=[];size=0;}chunk.push(p);size+=p.bytes;}if(chunk.length)chunks.push(chunk);
 console.log(JSON.stringify({mode:execute?'execute':'dry-run',namespace,questions:28188,batches:batches.length,files:pins.files.length,uploads:chunks.length,bytes:pins.files.reduce((n,p)=>n+p.bytes,0)}));
 if(!execute)return;
 const api=new URL(option('--api')??'https://backend.remoa.com.br');
 if(api.protocol!=='https:'&&!(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)))throw Error('https_required');
 if(api.username||api.password||api.search||api.hash||api.pathname!=='/')throw Error('invalid_api_origin');
 let token=process.env.REMOA_ADMIN_TOKEN;
 if(process.env.REMOA_ADMIN_TOKEN_FILE){const s=await stat(process.env.REMOA_ADMIN_TOKEN_FILE);if(!s.isFile()||(s.mode&0o777)!==0o600)throw Error('token_file_requires_0600');token=(await readFile(process.env.REMOA_ADMIN_TOKEN_FILE,'utf8')).trim();}
 if(!token||/\s/.test(token))throw Error('legitimate_admin_token_required');
 const checkpoint=resolve(option('--checkpoint')??resolve(pkg,'headless-checkpoint.json'));
 let state={namespace,manifestHash,api:api.origin,completed:[]};
 try{state=JSON.parse(await readFile(checkpoint,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('invalid_checkpoint');}
 if(state.namespace!==namespace||state.manifestHash!==manifestHash||state.api!==api.origin||!Array.isArray(state.completed))throw Error('checkpoint_scope_changed');
 const save=async()=>{const temp=resolve(dirname(checkpoint),`.${key('checkpoint')}.tmp`);await writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(temp,checkpoint);};
 let last=0;
 async function request(path,body){
  for(let attempt=0;attempt<8;attempt++){
   await sleep(Math.max(0,2100-(Date.now()-last)));last=Date.now();let response;
   try{response=await fetch(new URL(path,api),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15*60*1000)});}catch{if(attempt===7)throw Error('transport_failed_resume_same_checkpoint');await sleep(Math.min(60000,1000*2**attempt));continue;}
   if(response.status===429||response.status>=500){if(attempt===7)throw Error(`retry_exhausted_http_${response.status}`);const wait=Number(response.headers.get('retry-after'));await sleep(Math.max(response.status===429?61000:1000*2**attempt,Number.isFinite(wait)?wait*1000:0));continue;}
   if(!response.ok)throw Error(`operation_failed_http_${response.status}`);
   const result=await response.json();if(result.ok!==true)throw Error('operation_rejected');return result.data;
  }
 }
 // This verifies the actual human session; no JWT decoding is accepted as authentication.
 await request('/v1/admin/me');
 async function operation(label,path,data){if(state.completed.includes(label))return;const result=await request(`/v1/admin/questions/team-publication/${path}`,{idempotencyKey:key(label),reason,...data});state.completed.push(label);await save();console.log(JSON.stringify({completed:label,count:result.count??result.results?.length??null,replayed:result.replayed??false}));}
 await operation('create','batches',{});
 for(let i=0;i<chunks.length;i++){const label=`assets-${i+1}`;if(state.completed.includes(label))continue;const files=[];for(const p of chunks[i])files.push({path:p.path,base64:(await readFile(safePath(originals,p.path))).toString('base64')});await operation(label,'assets',{files});}
 for(let i=0;i<batches.length;i++)await operation(`items-${i+1}`,'items',{batchIndex:i+1,rawJsonl:batches[i]});
 await operation('activate','activate',{});
 const status=await request('/v1/admin/questions/team-publication/status');
 if(Number(status.batch?.imported)!==28188||!status.batch?.activated_at||status.batch?.revoked_at)throw Error('final_readback_failed');
 console.log(JSON.stringify({verified:true,questions:28188,namespace}));
}
main().catch(error=>{const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'local_or_transport_error';console.error(`Headless publication stopped (${code}). Check local files, release, admin session, and checkpoint; secrets were not logged.`);process.exitCode=1;});
