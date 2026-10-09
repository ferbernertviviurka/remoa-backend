/** Separate creation sample: actual selection + 200 frozen items, unique idempotency keys, no provider calls. */
import {randomUUID} from 'node:crypto';
import {state,save} from './target.mjs';
const seeded=state(),base='http://127.0.0.1:43133',samples=[],failures=[];
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]??null;
async function create(user,record){
 const started=performance.now();
 try{
  const response=await fetch(base+'/v1/question-sessions',{method:'POST',headers:{authorization:'Bearer '+user.id,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({mode:'simulation',count:200,timerSec:null,shuffle:false,filters:{scope:'catalog',sourceId:seeded.source}}),signal:AbortSignal.timeout(15000)});
  const text=await response.text(),body=JSON.parse(text);
  if(response.status!==200||body.data.items.length!==200)throw Error('creation_response_'+response.status);
  if(body.data.items.some(item=>'correctKey'in item.question||'explanation'in item.question))throw Error('creation_reference_leak');
  if(record){const timings=Object.fromEntries((response.headers.get('server-timing')??'').split(',').flatMap(value=>{const match=value.trim().match(/^([\w-]+);dur=([\d.]+)/);return match?[[match[1],Number(match[2])]]:[];}));samples.push({ms:performance.now()-started,bytes:Buffer.byteLength(text),queries:Number(response.headers.get('x-remoa-queries')),timings});}
 }catch(error){failures.push({name:error instanceof Error?error.name:'error'});}
}
const startedAt=new Date().toISOString();
// One unmeasured warm request per owner; then five waves of20 concurrent users (<20/min/owner admission).
await Promise.all(seeded.users.map(user=>create(user,false)));
for(let wave=0;wave<5;wave++)await Promise.all(seeded.users.map(user=>create(user,true)));
const result={synthetic:true,startedAt,finishedAt:new Date().toISOString(),scope:'Separate creation-only sample, five waves of20 concurrent users; not a five-minute sustained load',vus:20,count:200,samples:samples.length,p50Ms:percentile(samples.map(s=>s.ms),.5),p95Ms:percentile(samples.map(s=>s.ms),.95),maxMs:Math.max(0,...samples.map(s=>s.ms)),p95Bytes:percentile(samples.map(s=>s.bytes),.95),maxQueries:Math.max(0,...samples.map(s=>s.queries)),failures:failures.length,targetP95Ms:400};
result.serverTimingP95Ms=Object.fromEntries([...new Set(samples.flatMap(s=>Object.keys(s.timings)))].map(key=>[key,percentile(samples.map(s=>s.timings[key]).filter(value=>value!==undefined),.95)]));
result.pass=result.failures===0&&result.p95Ms!==null&&result.p95Ms<=400;save('create-results.json',result);process.stdout.write(JSON.stringify(result)+'\n');if(!result.pass)process.exitCode=1;
