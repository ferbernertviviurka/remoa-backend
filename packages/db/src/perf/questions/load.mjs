/** FR32 loopback HTTP benchmark. Closed-loop 20 independent synthetic users, fixed 5 minutes. */
import {randomUUID} from 'node:crypto';
import {state,save} from './target.mjs';
const seeded=state(),base='http://127.0.0.1:43133',duration=300000,warmup=30000;
const operations=['search','filter','wrong','recent','resume','answer','create'];
const continuous=operations.filter(name=>name!=='create');
const samples=Object.fromEntries(operations.map(name=>[name,[]]));const failures=[];
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);const p=q=>sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]??null;return {count:sorted.length,p50Ms:p(.5),p95Ms:p(.95),maxMs:sorted.at(-1)??null};};
async function request(u,name,record){
 let path,method='GET',body;
 if(name==='search')path='/questions?scope=catalog&sourceId='+seeded.source+'&search=distinctive&limit=25';
 if(name==='filter')path='/questions?scope=catalog&sourceId='+seeded.source+'&areaId='+seeded.area+'&difficulty=medium&limit=25';
 if(name==='wrong')path='/questions?scope=catalog&sourceId='+seeded.source+'&state=wrong&limit=25';
 if(name==='recent')path='/question-sessions';
 if(name==='resume')path='/question-sessions/'+u.activeSessionId;
 if(name==='answer'){path='/question-sessions/'+u.activeSessionId+'/items/'+u.itemId+'/answer';method='PUT';body={selectedKey:u.revision%2?'B':'A',revision:u.revision,mutationId:randomUUID(),elapsedMs:1000};}
 if(name==='create'){path='/question-sessions';method='POST';body={mode:'simulation',count:200,timerSec:null,shuffle:false,filters:{scope:'catalog',sourceId:seeded.source}};}
 const t0=performance.now();let res,payload;
 try{res=await fetch(base+'/v1'+path,{method,headers:{authorization:'Bearer '+u.id,...(body?{'content-type':'application/json'}:{}),...(name==='create'?{'idempotency-key':randomUUID()}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const text=await res.text();payload=JSON.parse(text);
  if(res.status!==200)throw Error('HTTP_'+res.status+'_'+(payload.error?.code??'unknown'));
  if(name==='answer')u.revision=payload.data.revision;
  if(name==='create'){if(payload.data.items.length!==200||payload.data.items.some(item=>'correctKey'in item.question||'explanation'in item.question)||'report'in payload.data||'referenceSnapshot'in payload.data)throw Error('creation_count_or_reference');u.activeSessionId=payload.data.id;u.itemId=payload.data.items[0].id;u.revision=payload.data.items[0].revision;}
  if(name==='recent'&&payload.data.some(s=>'items'in s))throw Error('recent_full_payload');
  if(name==='resume'&&payload.data.items.length!==200)throw Error('resume_count');
  if(name==='search'||name==='filter'||name==='wrong'){if(payload.data.items.length>25)throw Error('unbounded_catalog');if(payload.data.items.some(q=>'correctKey'in q||'explanation'in q))throw Error('reference_leak');}
  if(record)samples[name].push({ms:performance.now()-t0,bytes:Buffer.byteLength(text),queries:Number(res.headers.get('x-remoa-queries'))});
 }catch(e){if(record)failures.push({name,status:res?.status??null,code:e instanceof Error?e.name:'error'});}
}
async function runFor(ms,record){const started=performance.now(),deadline=started+ms;await Promise.all(seeded.users.map(async u=>{let sequence=0,created=0;while(performance.now()<deadline){if(record&&created<5&&performance.now()>=started+created*60000){created++;await request(u,'create',true);}else await request(u,continuous[sequence++%continuous.length],record);}}));}
for(const u of seeded.users){const r=await fetch(base+'/v1/question-sessions/'+u.activeSessionId,{headers:{authorization:'Bearer '+u.id}});const p=await r.json();if(r.status!==200)throw Error('harness readiness failed');u.revision=p.data.items[0].revision;}
process.stdout.write('FR32 warm-up START '+new Date().toISOString()+':20VUs/30seconds\n');await runFor(warmup,false);
const startedAt=new Date().toISOString();process.stdout.write('FR32 measured load START '+startedAt+':20VUs/300seconds/100scheduledcreations\n');const t0=performance.now();await runFor(duration,true);
const metrics=Object.fromEntries(operations.map(name=>{const values=samples[name];const latency=summary(values.map(s=>s.ms));const target=['answer','resume','create'].includes(name)?400:500;return[name,{...latency,p95Bytes:summary(values.map(s=>s.bytes)).p95Ms,maxBytes:Math.max(0,...values.map(s=>s.bytes)),maxQueries:Math.max(0,...values.map(s=>s.queries)),targetP95Ms:target,pass:latency.p95Ms!==null&&latency.p95Ms<=target}];}));
if(metrics.create.count!==100)failures.push({name:'create',status:null,code:'create_sample_count'});
const result={synthetic:true,startedAt,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-t0),vus:20,warmupMs:warmup,durationMs:duration,creationSchedule:'One200-item creation per VU at0/60/120/180/240seconds;100scheduled samples; owner switches to the new active session',transport:'loopback HTTP, local Postgres, no artificial WAN latency',cache:'existing application defaults; unique answer mutations, active simulation; no question assets/OCR/provider calls',counts:seeded.counts,countsKind:'Initial seed; previous/load runs append answers and sessions',metrics,failures:failures.slice(0,100),failureCount:failures.length};
save('load-results.json',result);process.stdout.write(JSON.stringify(result)+'\n');if(failures.length||Object.values(metrics).some(m=>!m.pass))process.exitCode=1;
