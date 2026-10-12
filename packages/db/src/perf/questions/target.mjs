import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('./',import.meta.url));
const ok=/remoa_perf|f33_(test|bench)/,local=['localhost','127.0.0.1'];
// F33_PERF_DB (+ F33_PERF_DB_PORT, F33_PERF_HTTP_PORT) selects another isolated DB (e.g. remoa_f33_bench); outputs go to ./bench/. Default: URL file + remoa_perf_f33_20261008.
export const explicitDb=process.env.F33_PERF_DB;
export const directory=explicitDb?root+'bench/':root;
if(explicitDb)mkdirSync(directory,{recursive:true});
export const port=Number(process.env.F33_PERF_HTTP_PORT??(explicitDb?43177:43133));
export const targetUrl=()=>{
 let url;
 if(explicitDb){if(!ok.test(explicitDb)||!/^[a-z0-9_]+$/.test(explicitDb))throw Error('refused: db name must match remoa_perf|f33_(test|bench)');
  url=new URL(`postgresql://postgres:postgres@127.0.0.1:${process.env.F33_PERF_DB_PORT??54322}/${explicitDb}`);}
 else{url=new URL(readFileSync(process.env.F33_PERF_URL_FILE??'/private/tmp/remoa-f33-perf-url','utf8').trim());if(url.pathname!=='/remoa_perf_f33_20261008')throw Error('explicit isolated F33 perf target required');}
 if(!local.includes(url.hostname)||!ok.test(url.pathname))throw Error('refused: localhost + isolated F33 db only');
 return url.toString();};
export const save=(name,value)=>writeFileSync(directory+name,JSON.stringify(value,null,2)+'\n',{mode:0o600});
export const state=()=>JSON.parse(readFileSync(directory+'seed-state.json','utf8'));
