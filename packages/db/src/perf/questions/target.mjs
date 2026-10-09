import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const directory=fileURLToPath(new URL('./',import.meta.url));
export const targetUrl=()=>{const url=new URL(readFileSync(process.env.F33_PERF_URL_FILE??'/private/tmp/remoa-f33-perf-url','utf8').trim());if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/remoa_perf_f33_20261008')throw Error('explicit isolated F33 perf target required');return url.toString();};
export const save=(name,value)=>writeFileSync(directory+name,JSON.stringify(value,null,2)+'\n',{mode:0o600});
export const state=()=>JSON.parse(readFileSync(directory+'seed-state.json','utf8'));
